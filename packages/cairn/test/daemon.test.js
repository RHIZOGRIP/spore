import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openCairn } from '../src/index.js'

const CAIRN = fileURLToPath(new URL('../bin/cairn.js', import.meta.url))
const TOKEN = 'the-ops-token'

const INSTANCE = {
  members: { main: 'lead', vdg: 'auditor', 'stripe-feed': 'source', clb: 'owner' },
  kinds: {
    'task.open': { title: 'string', 'note?': 'string' },
    'task.claim': {},
    'payment.seen': { amount: 'integer', currency: 'string', lines: [{ sku: 'string', qty: 'integer' }], raw: 'any' }
  },
  subjects: { task: 'seq', customer: '^cus_[A-Za-z0-9]+$', evidence: 'sha256' }
}

let dir, instanceFile, db, socket, daemon

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cairn-daemon-'))
  instanceFile = join(dir, 'ops.json')
  db = join(dir, 'cairn.sqlite')
  socket = join(dir, 'ops.sock')
  writeFileSync(instanceFile, JSON.stringify(INSTANCE))
})

afterEach(async () => {
  if (daemon) await stop(daemon)
  daemon = null
  rmSync(dir, { recursive: true, force: true })
})

function run (env = { CAIRN_OPS_TOKEN: TOKEN }) {
  const child = spawn(process.execPath, [CAIRN, 'serve', instanceFile, '--db', db, '--socket', socket], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve({ code, stderr })))
  return { child, exited }
}

async function start () {
  const { child, exited } = run()
  let serving = false
  await Promise.race([
    new Promise((resolve) => child.stdout.once('data', resolve)).then(() => { serving = true }),
    exited.then(({ code, stderr }) => { if (!serving) throw new Error(`cairn exited ${code}: ${stderr}`) })
  ])
  return child
}

async function stop (child) {
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  await exited
}

function post (body, headers = {}, path = '/append') {
  const sent = {
    'content-type': 'application/json',
    authorization: `Bearer ${TOKEN}`,
    'x-cairn-actor': 'main',
    'x-cairn-via': 'agent',
    'x-cairn-id': 'turn-7',
    'x-cairn-hop': '0',
    ...headers
  }
  for (const [key, value] of Object.entries(sent)) if (value === null) delete sent[key]
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path, method: 'POST', headers: sent, agent: false }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
    })
    req.once('error', reject)
    req.end(JSON.stringify(body))
  })
}

const entries = () => {
  const reader = new DatabaseSync(db, { readOnly: true })
  const rows = reader.prepare('SELECT line FROM t_entries ORDER BY seq').all().map(row => JSON.parse(row.line))
  reader.close()
  return rows
}

const AT = '2026-01-01T00:00:00.000Z'
const open = (title = 'ship it') => ({ kind: 'task.open', at: AT, refs: {}, data: { title } })
const claim = (task, extra = {}) => ({ kind: 'task.claim', at: AT, refs: { task }, data: {}, ...extra })

describe('the daemon', () => {
  it('stamps who wrote from the headers and the instance file, never from the body', async () => {
    daemon = await start()
    const { status, body } = await post(open())
    expect(status).toBe(200)
    expect(body).toMatchObject({ seq: 2 })
    expect(entries()[1]).toMatchObject({
      seq: 2, cairn: 'ops', kind: 'task.open', actor: { name: 'main', role: 'lead', via: 'agent' }, id: 'turn-7', hop: 0
    })
    const forged = await post({ ...open(), actor: { name: 'clb', role: 'owner', via: 'cli' } })
    expect(forged).toMatchObject({ status: 422, body: { error: { type: 'shape-mismatch', detail: '$.actor' } } })
    const unstamped = await post(open(), { 'x-cairn-id': null, 'x-cairn-via': 'program', 'x-cairn-actor': 'stripe-feed' })
    expect(unstamped.status).toBe(200)
    expect(entries()[2]).toMatchObject({ actor: { name: 'stripe-feed', role: 'source', via: 'program' }, id: null })
  })

  it('takes nested fields, lists and any where a kind declares them', async () => {
    daemon = await start()
    const { body: { sha256 } } = await post({ base64: Buffer.from('{"id":"pi_1"}').toString('base64') }, {}, '/evidence')
    const payment = {
      kind: 'payment.seen',
      at: AT,
      refs: { customer: 'cus_A1', evidence: sha256 },
      data: { amount: 1250, currency: 'eur', lines: [{ sku: 'x1', qty: 2 }], raw: { id: 'pi_1', meta: { tags: ['a', null, true] } } }
    }
    expect((await post(payment)).status).toBe(200)
    expect(entries()[1].data).toEqual(payment.data)
  })

  it('refuses an append without the cairn\'s token, before anything else (A18)', async () => {
    daemon = await start()
    for (const authorization of [null, 'Bearer the-wrong-token', TOKEN]) {
      const { status, body } = await post(open(), { authorization, 'x-cairn-actor': 'main' })
      expect(status, String(authorization)).toBe(401)
      expect(body.error.type).toBe('unauthenticated')
    }
    expect((await post(open(), { authorization: null, 'x-cairn-actor': 'stranger' })).body.error.type).toBe('unauthenticated')
    expect(entries().map(e => e.kind)).toEqual(['cairn.config'])
  })

  it('refuses each of the eight with its code, and writes nothing (A4)', async () => {
    daemon = await start()
    expect((await post(open())).body.seq).toBe(2)
    const cases = [
      ['no token', open(), { authorization: 'Bearer nope' }, 401, 'unauthenticated', ''],
      ['a stranger', open(), { 'x-cairn-actor': 'stranger' }, 403, 'not-a-member', 'stranger'],
      ['a kind not declared', { ...open(), kind: 'task.lost' }, {}, 422, 'unknown-kind', 'task.lost'],
      ['a field missing', { ...open(), data: {} }, {}, 422, 'shape-mismatch', '$.data.title'],
      ['a field not declared', { ...open(), data: { title: 'x', owner: 'vdg' } }, {}, 422, 'shape-mismatch', '$.data.owner'],
      ['a wrong type, nested', { kind: 'payment.seen', at: AT, refs: {}, data: { amount: 1, currency: 'eur', lines: [{ sku: 'x', qty: '2' }], raw: null } }, {}, 422, 'shape-mismatch', '$.data.lines[0].qty'],
      ['a float under any', { kind: 'payment.seen', at: AT, refs: {}, data: { amount: 1, currency: 'eur', lines: [], raw: { rate: 1.5 } } }, {}, 422, 'shape-mismatch', '$.data.raw.rate'],
      ['a field the writer does not send', { ...open(), hop: 0 }, {}, 422, 'shape-mismatch', '$.hop'],
      ['a via that is none of the three', open(), { 'x-cairn-via': 'person' }, 422, 'shape-mismatch', '$.actor.via'],
      ['a subject not declared', { ...open(), refs: { order: 'o1' } }, {}, 422, 'bad-ref', '$.refs.order'],
      ['a value off its pattern', { ...open(), refs: { customer: 'cust_1' } }, {}, 422, 'bad-ref', '$.refs.customer'],
      ['a seq not in the cairn', claim(99), {}, 422, 'bad-ref', '$.refs.task'],
      ['a seq spelled as a string', claim('2'), {}, 422, 'bad-ref', '$.refs.task'],
      ['a sha256 in uppercase', { ...open(), refs: { evidence: 'A'.repeat(64) } }, {}, 422, 'bad-ref', '$.refs.evidence'],
      ['evidence the cairn does not hold', { ...open(), refs: { evidence: 'b'.repeat(64) } }, {}, 422, 'bad-ref', '$.refs.evidence'],
      ['a time in the future', { ...open(), at: '2999-01-01T00:00:00.000Z' }, {}, 422, 'bad-time', '$.at'],
      ['a time with no zone', { ...open(), at: '2026-01-01T00:00:00.000' }, {}, 422, 'bad-time', '$.at'],
      ['a time without milliseconds', { ...open(), at: '2026-01-01T00:00:00Z' }, {}, 422, 'bad-time', '$.at'],
      ['a day that does not exist', { ...open(), at: '2026-02-30T00:00:00.000Z' }, {}, 422, 'bad-time', '$.at'],
      ['a head that moved', claim(2, { expectedHead: 1 }), {}, 409, 'stale-head', '2'],
      ['a line past 4 KB', open('x'.repeat(5000)), {}, 413, 'too-large', expect.any(String)]
    ]
    for (const [label, body, headers, status, type, detail] of cases) {
      const res = await post(body, headers)
      expect(res.status, label).toBe(status)
      expect(res.body.error, label).toMatchObject({ type, detail })
    }
    expect(entries()).toHaveLength(2)
    const cairn = openCairn(db, { name: 'ops' })
    expect(cairn.verify()).toEqual({ ok: true, checked: 2 })
    cairn.close()
  })

  it('takes a time a little ahead of its clock, and refuses one further ahead', async () => {
    daemon = await start()
    const ahead = (ms) => ({ ...open(), at: new Date(Date.now() + ms).toISOString() })
    expect((await post(ahead(30 * 1000))).status).toBe(200)
    expect((await post(ahead(5 * 60 * 1000))).body.error).toMatchObject({ type: 'bad-time', detail: '$.at' })
  })

  it('lands one of two appends that read the same head (A9)', async () => {
    daemon = await start()
    await post(open())
    const first = await post(claim(2, { expectedHead: 2 }), { 'x-cairn-actor': 'main' })
    const second = await post(claim(2, { expectedHead: 2 }), { 'x-cairn-actor': 'vdg' })
    expect(first).toMatchObject({ status: 200, body: { seq: 3 } })
    expect(second).toMatchObject({ status: 409, body: { error: { type: 'stale-head', detail: '3' } } })
  })

  it('gives eight concurrent appenders one strictly increasing seq (A8)', async () => {
    daemon = await start()
    const writers = ['main', 'vdg', 'stripe-feed', 'clb', 'main', 'vdg', 'stripe-feed', 'clb']
    const seqsOf = await Promise.all(writers.map(async (actor) => {
      const seqs = []
      for (let n = 0; n < 25; n++) {
        const { status, body } = await post(open(`${actor} ${n}`), { 'x-cairn-actor': actor })
        expect(status).toBe(200)
        seqs.push(body.seq)
      }
      return seqs
    }))
    for (const seqs of seqsOf) expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(seqsOf.flat().sort((a, b) => a - b)).toEqual(Array.from({ length: 200 }, (_, i) => i + 2))
    const cairn = openCairn(db, { name: 'ops' })
    expect(cairn.verify()).toEqual({ ok: true, checked: 201 })
    cairn.close()
  })

  it('records the instance file once, and again only when it changes (A13)', async () => {
    const configs = () => entries().filter(e => e.kind === 'cairn.config')
    daemon = await start()
    await stop(daemon)
    daemon = await start()
    await stop(daemon)
    expect(configs()).toHaveLength(1)
    expect(configs()[0]).toMatchObject({ seq: 1, actor: { name: 'cairn', role: 'cairn', via: 'program' }, data: INSTANCE })

    const changed = { ...INSTANCE, members: { ...INSTANCE.members, foreman: 'lead' } }
    writeFileSync(instanceFile, JSON.stringify(changed, null, 2))
    daemon = await start()
    await stop(daemon)
    daemon = await start()
    expect(configs()).toHaveLength(2)
    expect(configs()[1].data).toEqual(changed)
    expect((await post(open(), { 'x-cairn-actor': 'foreman' })).body).toMatchObject({ seq: 3 })
  })

  it('serves again after being killed, over the socket it left behind', async () => {
    daemon = await start()
    daemon.kill('SIGKILL')
    await new Promise((resolve) => daemon.once('exit', resolve))
    expect(existsSync(socket)).toBe(true)
    daemon = await start()
    expect((await post(open())).status).toBe(200)
  })

  it('refuses to start with no token, or on an instance file it cannot hold', async () => {
    expect(await run({ CAIRN_OPS_TOKEN: '' }).exited).toMatchObject({ code: 2, stderr: expect.stringContaining('CAIRN_OPS_TOKEN') })
    writeFileSync(instanceFile, JSON.stringify({ ...INSTANCE, kinds: { 'cairn.config': {} } }))
    expect(await run().exited).toMatchObject({ code: 1, stderr: expect.stringContaining('kinds under cairn.') })
    writeFileSync(instanceFile, JSON.stringify({ ...INSTANCE, subjects: { customer: 'cus_' } }))
    expect(await run().exited).toMatchObject({ code: 1, stderr: expect.stringContaining('anchored') })
    writeFileSync(instanceFile, JSON.stringify({ ...INSTANCE, kinds: { 'task.open': { title: 'text' } } }))
    expect(await run().exited).toMatchObject({ code: 1, stderr: expect.stringContaining('kinds.task.open.title') })
    writeFileSync(instanceFile, JSON.stringify(INSTANCE))
    socket = join(dir, `${'s'.repeat(110)}.sock`)
    expect(await run().exited).toMatchObject({ code: 1, stderr: expect.stringContaining('a unix socket path is at most 107') })
    expect(existsSync(db)).toBe(false)
  })
})

describe('the evidence store', () => {
  const evidenceDir = () => join(dir, 'evidence')
  const evidence = (bytes, headers) => post({ base64: bytes.toString('base64') }, headers, '/evidence')

  it('keeps a file by its hash, read-only, once, for an entry to cite', async () => {
    daemon = await start()
    const bytes = Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from('a page, fetched')])
    const sha256 = execFileSync('sha256sum', { input: bytes }).toString().split(' ')[0]
    expect(await evidence(bytes)).toEqual({ status: 200, body: { sha256, bytes: bytes.length } })
    expect(await evidence(bytes, { 'x-cairn-actor': 'vdg' })).toEqual({ status: 200, body: { sha256, bytes: bytes.length } })
    const kept = join(evidenceDir(), sha256)
    expect(readFileSync(kept)).toEqual(bytes)
    expect(statSync(kept).mode & 0o777).toBe(0o444)
    expect(readdirSync(evidenceDir())).toEqual([sha256])
    expect(await post({ ...open(), refs: { evidence: sha256 } })).toMatchObject({ status: 200, body: { seq: 2 } })
    expect(entries()[1].refs).toEqual({ evidence: sha256 })
  })

  it('refuses what it cannot keep, and keeps nothing of it', async () => {
    daemon = await start()
    const cases = [
      ['no token', { base64: 'aGk=' }, { authorization: null }, 401, 'unauthenticated', ''],
      ['a stranger', { base64: 'aGk=' }, { 'x-cairn-actor': 'stranger' }, 403, 'not-a-member', 'stranger'],
      ['not base64', { base64: 'not base64!' }, {}, 422, 'shape-mismatch', '$.base64'],
      ['base64 without its padding', { base64: 'aGk' }, {}, 422, 'shape-mismatch', '$.base64'],
      ['a key besides base64', { base64: 'aGk=', name: 'page.html' }, {}, 422, 'shape-mismatch', '$.name'],
      ['past 16 MB', { base64: Buffer.alloc(16 * 1024 * 1024 + 1).toString('base64') }, {}, 413, 'too-large', String(16 * 1024 * 1024 + 1)]
    ]
    for (const [label, body, headers, status, type, detail] of cases) {
      const res = await post(body, headers, '/evidence')
      expect(res.status, label).toBe(status)
      expect(res.body.error, label).toMatchObject({ type, detail })
    }
    expect(readdirSync(evidenceDir())).toEqual([])
  })
})
