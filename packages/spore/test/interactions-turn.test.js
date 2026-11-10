/**
 * Interactions asked from real turns: the runner's interact socket, the data frozen from a
 * directory descriptor, the helper's handoff to a signed service on loopback and to a program, and
 * the outcome back through `spore-api` and `spore interaction outcome`. Only the model's replies
 * are scripted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { startGate } from './fixtures/model-server.js'
import { outsideRoot, withAuth } from './fixtures/outside-ws.js'
import { answers, calls, scriptedMo } from './fixtures/scripted-model.js'
import { canonical, handAsked, receiptOf, sha256 } from '../src/core/interactions.js'
import { interactionsIn, readInbox, readTurns, saidOf } from '../src/core/spore-dir.js'
import { loadApi } from '../api/config.js'
import { createApiServer } from '../api/server.js'
import { definitionWith } from '../src/testing.js'
import { forkWorkspace } from '../src/core/fork.js'
import { readCalls } from '../src/core/call-record.js'
import { flush } from '../src/library/verbs.js'

const run = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const SPORE = resolve(__dirname, '../../spore-cli/bin/spore.js')
const INTERACTIONS_MODULE = resolve(__dirname, '../src/core/interactions.js')
const SECRET = 's3cret-for-tests'

let root
let ws
let gate
let script
let service
let prompts
let program

const env = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME })
const config = (...path) => join(process.env.XDG_CONFIG_HOME, 'spore', ...path)

const spore = async (...args) => {
  try {
    const { stdout, stderr } = await run(process.execPath, [SPORE, ...args], { env: env() })
    return { code: 0, stdout, stderr }
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr }
  }
}

const send = (prompt) => spore('send', ws, prompt)

function startService ({ failFirst = 0 } = {}) {
  const held = new Map()
  const received = []
  let failing = failFirst
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString()
    const at = req.headers['x-spore-timestamp']
    const signed = `sha256=${createHmac('sha256', SECRET).update(`${at}.${req.method} ${req.url}.${body}`).digest('hex')}`
    const reply = (status, answer) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(answer))
    if (req.headers['x-spore-signature'] !== signed || Math.abs(Date.now() / 1000 - Number(at)) > 300) return reply(401, { type: 'UNSIGNED', message: 'unsigned' })
    const payload = body ? JSON.parse(body) : null
    received.push({ method: req.method, url: req.url, payload })
    if (failing > 0) {
      failing--
      return reply(503, { type: 'BUSY', message: 'busy' })
    }
    const [, id, verb] = /^\/v1\/interactions(?:\/([^/]+))?(?:\/(cancel))?$/.exec(req.url) ?? []
    const link = (id) => `https://ask.example/i/${id}`
    if (req.method === 'POST' && !id) {
      const known = held.get(payload.id)
      if (known && known.dataHash !== payload.dataHash) return reply(409, { type: 'INTERACTION_CONFLICT', message: 'conflict' })
      held.set(payload.id, { dataHash: payload.dataHash, state: 'pending' })
      return reply(known ? 200 : 201, { id: payload.id, state: 'pending', link: link(payload.id) })
    }
    if (!held.has(id)) return reply(404, { type: 'INTERACTION_UNKNOWN', message: 'unknown' })
    if (verb === 'cancel') {
      held.get(id).state = 'cancelled'
      return reply(200, { state: 'cancelled' })
    }
    return reply(200, { id, state: held.get(id).state, link: link(id), outcome: 'pending' })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}/`,
    received,
    close: () => new Promise(resolve => server.close(resolve))
  })))
}

function writeProgram () {
  const dir = join(root, 'to-file')
  mkdirSync(join(dir, 'requests'), { recursive: true })
  const path = join(dir, 'handler.js')
  writeFileSync(path, `#!${process.execPath}
const { existsSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const dir = ${JSON.stringify(dir)}
const verb = process.argv[2]
const request = JSON.parse(readFileSync(0, 'utf8'))
if (verb !== 'create') {
  console.log(JSON.stringify({ type: 'NOT_HANDLED', message: verb + ' is not handled here' }))
  process.exit(1)
}
if (existsSync(dir + '/not-now')) {
  rmSync(dir + '/not-now')
  process.exit(75)
}
writeFileSync(dir + '/requests/' + request.id + '.json', JSON.stringify(request))
console.log(JSON.stringify({ id: request.id, state: 'pending' }))
`)
  chmodSync(path, 0o755)
  return { dir, path, request: (id) => JSON.parse(readFileSync(join(dir, 'requests', `${id}.json`), 'utf8')) }
}

const handlers = () => ({
  review: { url: service.url, secret: '${REVIEW_SECRET}', what: 'a person keeps or drops each change' }, // eslint-disable-line no-template-curly-in-string
  'to-file': { program: program.path, what: 'written down, answered later' }
})

const configure = (fields) => gate.configure({ home: root, interactions: handlers(), ...fields }, config('config.json'))

const writeData = (dir = 'data/review') => [
  calls('write', { path: `${dir}/changes.json`, content: '[{"line":3}]' }),
  calls('write', { path: `${dir}/app/run.js`, content: 'show(changes)' })
]

const said = (file) => readFileSync(join(ws, 'data', file), 'utf8')

const readdirOf = (dir) => existsSync(dir) ? readdirSync(dir) : []

beforeEach(async () => {
  root = outsideRoot('interact')
  ws = join(root, 'asker')
  mkdirSync(ws)
  writeFileSync(join(ws, 'spore.cmk'), withAuth(definitionWith('anthropic/claude-haiku-4-5')).replace(/^---\n/, '---\ninteractions: 2\ninteractions.handlers: [review, to-file]\n'))
  script = []
  prompts = []
  gate = await startGate({
    mo: scriptedMo(async (prompt) => {
      prompts.push(JSON.stringify(prompt))
      return script.shift()
    }),
    name: 'interact-turn'
  })
  service = await startService()
  program = writeProgram()
  mkdirSync(config(), { recursive: true })
  configure({})
  writeFileSync(config('environment'), `REVIEW_SECRET=${SECRET}\n`)
})

afterEach(async () => {
  await service.close()
  await gate.close()
  rmSync(config('config.json'), { force: true })
  rmSync(config('environment'), { force: true })
  rmSync(config('api.json'), { force: true })
  rmSync(root, { recursive: true, force: true })
})

describe('an interaction asked from a turn', () => {
  it('is frozen, stamped with what the runner knows and handed over signed, the agent never sees an address or the secret, and a fork leaves it behind', async () => {
    script.push(
      ...writeData(),
      calls('wsexec', { command: 'node "$SPORE_INTERACT" handlers', out: 'data/handlers.json' }),
      calls('wsexec', { command: 'node "$SPORE_INTERACT" create review data/review --key first', out: 'data/created.json' }),
      calls('wsexec', { command: 'printenv REVIEW_SECRET || echo none', out: 'data/secret.txt' }),
      answers('asked')
    )
    const asked = await send('ask the editor')
    expect(asked.code, asked.stderr).toBe(0)
    expect(JSON.parse(said('handlers.json'))).toEqual({ handlers: [{ name: 'review', what: 'a person keeps or drops each change' }, { name: 'to-file', what: 'written down, answered later' }] })
    const created = JSON.parse(said('created.json'))
    expect(created).toMatchObject({ handler: 'review', state: 'handed', link: `https://ask.example/i/${created.id}` })
    expect(said('secret.txt')).toBe('none\n')

    const [sent] = service.received
    const [turn] = readTurns(ws)
    expect(sent).toMatchObject({ method: 'POST', url: '/v1/interactions' })
    expect(sent.payload).toMatchObject({ v: 1, id: created.id, handler: 'review', spore: basename(ws), route: 'terminal', origin: { turnId: turn.turnId, inbox: [1] }, expires: null, supersedes: null })
    expect(sent.payload.files.map(file => file.path)).toEqual(['app/run.js', 'changes.json'])
    const listed = sent.payload.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
    expect(sent.payload.dataHash).toBe(sha256(canonical({ handler: 'review', files: listed })))
    expect(sent.payload.dataHash).toBe(created.dataHash)
    expect(Buffer.from(sent.payload.files[0].data, 'base64').toString()).toBe('show(changes)')
    expect(readFileSync(join(ws, 'interactions', created.id, 'app', 'run.js'), 'utf8')).toBe('show(changes)')
    expect(interactionsIn(ws)).toMatchObject([{ id: created.id, key: 'first', handler: 'review', state: 'handed', turnId: turn.turnId, route: 'terminal', processed: 0 }])
    expect(JSON.stringify(prompts)).not.toContain(service.url)

    const forked = forkWorkspace({ run: ws, into: join(root, 'forked') })
    expect(interactionsIn(forked.ws)).toEqual([])
    expect(existsSync(join(forked.ws, 'interactions'))).toBe(false)
  })

  it('refuses a handler the spore is not granted, a link in the data, a socket key that is not the tree\'s, and more than the turn is granted', async () => {
    const wrongKey = "require('node:http').request({ socketPath: process.env.SPORE_INTERACT_SOCKET, path: '/list', method: 'POST', headers: { 'x-spore-key': 'wrong' } }, (res) => { console.log(res.statusCode); process.exit(0) }).end('{}')" // eslint-disable-line quotes
    script.push(
      ...writeData(),
      calls('wsexec', { command: 'node "$SPORE_INTERACT" create elsewhere data/review', out: 'data/elsewhere.txt', err: 'data/elsewhere.err' }),
      calls('wsexec', { command: 'mkdir -p data/linked && ln -s /etc/passwd data/linked/passwd && node "$SPORE_INTERACT" create review data/linked', out: 'data/linked.txt', err: 'data/linked.err' }),
      calls('wsexec', { command: `node -e ${JSON.stringify(wrongKey)}`, out: 'data/key.txt' }),
      calls('wsexec', { command: 'for k in a b c; do node "$SPORE_INTERACT" create review data/review --key $k 2>&1; done', out: 'data/loop.txt' }),
      answers('tried')
    )
    const tried = await send('try everything')
    expect(tried.code, tried.stderr).toBe(0)
    expect(said('elsewhere.err')).toMatch(/^interact: INTERACTION_HANDLER: this spore is not granted the handler elsewhere — it may ask review, to-file/)
    expect(said('linked.err')).toMatch(/^interact: INTERACTION_DATA: .*passwd is a symbolic link/)
    expect(said('key.txt')).toBe('401\n')
    const lines = said('loop.txt').trim().split('\n')
    expect(lines.slice(0, 2).map(line => JSON.parse(line).state)).toEqual(['handed', 'handed'])
    expect(lines[2]).toMatch(/^interact: INTERACTIONS_TURN_FULL: this turn has asked 2 interactions/)
    expect(service.received).toHaveLength(2)
    expect(interactionsIn(ws).map(row => row.key).sort()).toEqual(['a', 'b'])
    expect(readdirOf(join(ws, 'interactions')).sort()).toEqual(interactionsIn(ws).map(row => row.id).sort())
  })

  it('needs a route named when the turn may be answered in more than one place, and takes only one of them', async () => {
    configure({ replyTo: { asker: 'telegram:main/42' } })
    script.push(
      ...writeData(),
      calls('wsexec', { command: 'node "$SPORE_INTERACT" create review data/review', out: 'data/none.txt', err: 'data/none.err' }),
      calls('wsexec', { command: 'node "$SPORE_INTERACT" create review data/review --route telegram:main/7', out: 'data/other.txt', err: 'data/other.err' }),
      calls('wsexec', { command: 'node "$SPORE_INTERACT" create review data/review --route telegram:main/42', out: 'data/named.json' }),
      answers('routed')
    )
    const routed = await send('ask somewhere')
    expect(routed.code, routed.stderr).toBe(0)
    expect(said('none.err')).toMatch(/^interact: INTERACTION_ROUTES: .*name one with --route: terminal, telegram:main\/42/)
    expect(said('other.err')).toMatch(/^interact: INTERACTION_ROUTES: telegram:main\/7 is not where/)
    expect(service.received.map(r => r.payload.route)).toEqual(['telegram:main/42'])
  })

  it('stays asked while the service is down, is handed over by a later pass, and is cancelled only once the service says so', async () => {
    await service.close()
    service = await startService({ failFirst: 1 })
    configure({})
    script.push(
      ...writeData(),
      calls('wsexec', { command: 'node "$SPORE_INTERACT" create review data/review', out: 'data/created.json' }),
      answers('asked')
    )
    const asked = await send('ask while it is down')
    expect(asked.code, asked.stderr).toBe(0)
    const created = JSON.parse(said('created.json'))
    expect(created).toMatchObject({ state: 'asked', unreachable: expect.stringMatching(/answered 503/) })
    expect(created.link).toBeUndefined()

    const passed = await handAsked(ws, { configFile: config('config.json'), env: { REVIEW_SECRET: SECRET } })
    expect(passed).toEqual({ handed: [created.id], waiting: [], refused: [] })
    expect(service.received.map(r => r.payload.id)).toEqual([created.id, created.id])
    expect(interactionsIn(ws)[0]).toMatchObject({ state: 'handed', link: `https://ask.example/i/${created.id}` })

    script.push(
      calls('wsexec', { command: `node "$SPORE_INTERACT" status ${created.id}`, out: 'data/status.json' }),
      calls('wsexec', { command: `node "$SPORE_INTERACT" cancel ${created.id}`, out: 'data/cancelled.json' }),
      calls('wsexec', { command: 'node "$SPORE_INTERACT" ls', out: 'data/ls.json' }),
      answers('cancelled')
    )
    const cancelled = await send('cancel it')
    expect(cancelled.code, cancelled.stderr).toBe(0)
    expect(JSON.parse(said('status.json'))).toMatchObject({ state: 'handed', processed: false, said: { state: 'pending', outcome: 'pending' } })
    expect(JSON.parse(said('cancelled.json'))).toMatchObject({ id: created.id, state: 'cancelled' })
    expect(JSON.parse(said('ls.json')).interactions).toMatchObject([{ id: created.id, state: 'cancelled' }])
    expect(service.received.at(-1)).toMatchObject({ method: 'POST', url: `/v1/interactions/${created.id}/cancel`, payload: { v: 1, id: created.id } })
  })

  it('is refused when its turn starts if a granted handler is one the host does not describe', async () => {
    configure({ interactions: { review: handlers().review } })
    script.push(answers('never reached'))
    const refused = await send('ask with a handler missing')
    expect(refused.code).not.toBe(0)
    expect(readTurns(ws)[0]).toMatchObject({ stopReason: 'error', error: 'START_FAILED', detail: expect.stringMatching(/grants the handler to-file and config.json does not describe it/) })
  })
})

describe('the outcome of an interaction', () => {
  const SERVICE_TOKEN = 'interaction-service-token-0123456789abcdef'
  const OTHER_TOKEN = 'another-caller-token-0123456789abcdefghij'
  let api
  let socket

  const post = (path, body, token = SERVICE_TOKEN) => new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, method: 'POST', path, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (res) => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })

  const until = async (check, ms = 15_000) => {
    const deadline = Date.now() + ms
    while (!check()) {
      if (Date.now() > deadline) throw new Error('timed out')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  const submitted = (row, answer, { attachments = [], responder } = {}) => {
    const outcome = {
      v: 1,
      outcome: 'submitted',
      dataHash: row.dataHash,
      answer,
      attachments,
      ...(responder === undefined ? {} : { responder }),
      submittedAt: '2028-03-02T09:14:40Z'
    }
    return { ...outcome, receipt: receiptOf({ ...outcome, id: row.id }) }
  }

  beforeEach(async () => {
    socket = join(root, 'api.sock')
    writeFileSync(config('api.json'), JSON.stringify({
      socket,
      callers: {
        asking: { token: '${API_ASKING}', spores: ['asker'] }, // eslint-disable-line no-template-curly-in-string
        other: { token: '${API_OTHER}', spores: ['someone-else'] } // eslint-disable-line no-template-curly-in-string
      }
    }))
    const secrets = { API_ASKING: SERVICE_TOKEN, API_OTHER: OTHER_TOKEN }
    api = createApiServer({ api: loadApi(config('api.json'), secrets), env: { ...env(), ...secrets } })
    await new Promise(resolve => api.listen(socket, resolve))
  })

  afterEach(async () => {
    await new Promise(resolve => api.close(resolve))
  })

  it('comes through spore-api, is checked against what the spore asked, said once to the route it recorded, and read by a turn it starts', async () => {
    script.push(
      ...writeData(),
      calls('wsexec', { command: 'node "$SPORE_INTERACT" create review data/review --key a && node "$SPORE_INTERACT" create review data/review --key b', out: 'data/created.jsonl' }),
      answers('asked')
    )
    const asked = await send('ask twice')
    expect(asked.code, asked.stderr).toBe(0)
    const [second, first] = interactionsIn(ws)
    const path = (id) => `/v1/spores/asker/interactions/${id}/outcome`
    const marks = Buffer.from('marks')
    const attachment = { name: 'marks.png', mime: 'image/png', sha256: sha256(marks), data: marks.toString('base64') }
    const responder = { id: 'op-1', name: 'Ada', method: 'passkey' }
    const outcome = submitted(first, { keep: [1, 3] }, { attachments: [attachment], responder })

    expect((await post(path(first.id), { ...outcome, receipt: sha256('forged') })).body.error).toMatchObject({ type: 'INTERACTION_OUTCOME', detail: 'the receipt does not recompute from the outcome' })
    expect((await post(path(first.id), { ...outcome, dataHash: sha256('other') })).body.error.type).toBe('INTERACTION_OUTCOME')
    expect((await post(path(first.id), submitted(first, { keep: [1, 3] }, { attachments: [{ ...attachment, data: Buffer.from('changed').toString('base64') }] }))).body.error.detail).toMatch(/does not hash to its sha256/)
    expect((await post(path(first.id), { ...outcome, route: 'telegram:evil/1' })).body.error.detail).toMatch(/not route/)
    expect((await post(path(first.id), { ...submitted(first, 'x'), responder: 'Ada' })).body.error.detail).toMatch(/responder is an object/)
    expect((await post(path('00000000-0000-4000-8000-000000000000'), outcome)).status).toBe(404)
    expect((await post(path(first.id), outcome, OTHER_TOKEN)).body.error.type).toBe('NOT_A_WORKSPACE')
    expect(interactionsIn(ws).map(row => row.state)).toEqual(['handed', 'handed'])

    script.push(answers('kept 1 and 3'))
    const taken = await post(path(first.id), outcome)
    expect(taken).toMatchObject({ status: 200, body: { repeated: false } })
    await until(() => readTurns(ws).length === 2)
    const entry = readInbox(ws).find(one => one.inboxNo === taken.body.inbox)
    expect(entry).toMatchObject({ interaction: first.id, requestId: `interaction:${first.id}`, replyTo: 'terminal' })
    expect(entry.files.map(file => file.name)).toEqual(['answer.json', 'marks.png'])
    expect(JSON.parse(readFileSync(join(ws, entry.files[0].path), 'utf8'))).toEqual({ keep: [1, 3] })
    expect(saidOf(entry)).toMatch(new RegExp(`^\\[Outcome of interaction ${first.id}, from a handler this host's operator describes`))
    expect(saidOf(entry)).toContain(`Asked of review at ${first.askedAt}, submitted 2028-03-02T09:14:40Z, answered by ${JSON.stringify(responder)}.`)
    expect(prompts.at(-1)).toContain(`Outcome of interaction ${first.id}`)
    await until(() => interactionsIn(ws).find(row => row.id === first.id).processed === 1)
    expect(interactionsIn(ws).find(row => row.id === first.id)).toMatchObject({ state: 'submitted', receipt: outcome.receipt, answeredInbox: taken.body.inbox })

    expect(await post(path(first.id), outcome)).toMatchObject({ status: 200, body: { inbox: taken.body.inbox, repeated: true } })
    expect((await post(path(first.id), submitted(first, { keep: [] }))).body.error.type).toBe('INTERACTION_ANSWERED')
    expect(readTurns(ws)).toHaveLength(2)

    script.push(answers('it expired'))
    const expired = await post(path(second.id), { v: 1, outcome: 'expired', dataHash: second.dataHash, at: '2028-04-01T00:00:00Z' })
    expect(expired).toMatchObject({ status: 200, body: { repeated: false } })
    await until(() => readTurns(ws).length === 3)
    const lapsed = readInbox(ws).find(one => one.inboxNo === expired.body.inbox)
    expect(lapsed.files ?? []).toEqual([])
    expect(saidOf(lapsed)).toContain('expired unanswered at 2028-04-01T00:00:00Z')
    expect(interactionsIn(ws).find(row => row.id === second.id).state).toBe('expired')
  }, 40_000)

  it('goes to a program and comes back through spore interaction outcome with nothing listening, and a turn cannot say one itself', async () => {
    writeFileSync(join(program.dir, 'not-now'), '')
    script.push(
      ...writeData('data/later'),
      calls('wsexec', { command: 'node "$SPORE_INTERACT" create to-file data/later', out: 'data/later.json' }),
      calls('wsexec', { command: 'node "$SPORE_INTERACT" create to-file data/later --key now', out: 'data/now.json' }),
      answers('asked')
    )
    const asked = await send('ask the file')
    expect(asked.code, asked.stderr).toBe(0)
    const later = JSON.parse(said('later.json'))
    const now = JSON.parse(said('now.json'))
    expect(later).toMatchObject({ handler: 'to-file', state: 'asked', unreachable: expect.stringMatching(/exited 75, not now/) })
    expect(now).toMatchObject({ handler: 'to-file', state: 'handed' })
    expect(now.link).toBeUndefined()
    expect(program.request(now.id)).toMatchObject({ v: 1, id: now.id, handler: 'to-file', spore: 'asker', dataHash: now.dataHash })
    expect(await handAsked(ws, { configFile: config('config.json'), env: {} })).toEqual({ handed: [later.id], waiting: [], refused: [] })
    expect(program.request(later.id).id).toBe(later.id)

    const row = interactionsIn(ws).find(one => one.id === now.id)
    const outcome = submitted(row, { written: true })
    writeFileSync(join(ws, 'data', 'outcome.json'), JSON.stringify(outcome))
    const sayItself = `import(${JSON.stringify(INTERACTIONS_MODULE)}).then(m => m.takeOutcome(process.env.SPORE_WS, ${JSON.stringify(now.id)}, JSON.parse(require('node:fs').readFileSync('data/outcome.json', 'utf8')), { env: process.env })).then(() => console.log('said'), e => console.log('refused'))`
    script.push(
      calls('wsexec', { command: `node -e ${JSON.stringify(sayItself)}`, out: 'data/itself.txt', err: 'data/itself.err' }),
      calls('wsexec', { command: `node "$SPORE_INTERACT" cancel ${later.id}`, out: 'data/cancelled.json' }),
      answers('tried')
    )
    const tried = await send('answer it yourself')
    expect(tried.code, tried.stderr).toBe(0)
    expect(said('itself.txt')).not.toBe('said\n')
    expect(interactionsIn(ws).find(one => one.id === now.id).state).toBe('handed')
    expect(JSON.parse(said('cancelled.json'))).toMatchObject({ id: later.id, state: 'cancelled', said: { refused: { type: 'NOT_HANDLED' } } })

    script.push(answers('written'))
    const file = join(root, 'outcome.json')
    writeFileSync(file, JSON.stringify(outcome))
    const taken = await spore('interaction', 'outcome', 'asker', now.id, file)
    expect(taken.code, taken.stderr).toBe(0)
    const line = JSON.parse(taken.stdout)
    expect(line).toMatchObject({ repeated: false })
    await until(() => readTurns(ws).length === 3)
    const entry = readInbox(ws).find(one => one.inboxNo === line.inbox)
    expect(saidOf(entry)).toContain(`Asked of to-file at ${row.askedAt}, submitted 2028-03-02T09:14:40Z. What it carries is answer.json.`)
    expect(JSON.parse((await spore('interaction', 'outcome', 'asker', now.id, file)).stdout)).toEqual({ inbox: line.inbox, repeated: true })

    const closedRow = interactionsIn(ws).find(one => one.id === later.id)
    writeFileSync(file, JSON.stringify(submitted(closedRow, { written: true })))
    const closed = await spore('interaction', 'outcome', 'asker', later.id, file)
    expect(closed.code).toBe(1)
    expect(JSON.parse(closed.stdout)).toMatchObject({ type: 'INTERACTION_CLOSED' })
  }, 40_000)

  it('outlives the run that asked it once retain drops that run, is named in a flush\'s note, and is answered after both', async () => {
    const definition = readFileSync(join(ws, 'spore.cmk'), 'utf8')
    expect(definition).toContain('\nretain: 10\n')
    writeFileSync(join(ws, 'spore.cmk'), definition.replace('\nretain: 10\n', '\nretain: 1\n'))
    script.push(
      ...writeData('data/later'),
      calls('wsexec', { command: 'node "$SPORE_INTERACT" create to-file data/later', out: 'data/later.json' }),
      answers('asked')
    )
    const asked = await send('ask the file')
    expect(asked.code, asked.stderr).toBe(0)
    const { id } = JSON.parse(said('later.json'))
    const [first] = readTurns(ws)
    expect(readCalls(ws, first.runId)).not.toHaveLength(0)

    script.push(answers('meanwhile'))
    const other = await send('something else')
    expect(other.code, other.stderr).toBe(0)
    expect(readCalls(ws, first.runId)).toEqual([])
    const row = interactionsIn(ws).find(one => one.id === id)
    expect(row).toMatchObject({ handler: 'to-file', state: 'handed', turnId: first.turnId })
    expect(readFileSync(join(ws, 'interactions', id, 'changes.json'), 'utf8')).toBe('[{"line":3}]')

    const flushed = flush({ ws, by: 'its operator', configFile: config('config.json') })
    expect(flushed.open.interactions).toEqual([{ id, handler: 'to-file', askedAt: row.askedAt }])

    script.push(answers('read it'))
    const file = join(root, 'outcome.json')
    writeFileSync(file, JSON.stringify(submitted(row, { written: true })))
    const taken = await spore('interaction', 'outcome', 'asker', id, file)
    expect(taken.code, taken.stderr).toBe(0)
    await until(() => readTurns(ws).length === 3)
    const prompt = prompts.at(-1)
    expect(prompt).toContain(`- interaction ${id}, asked of to-file at ${row.askedAt}, its data in interactions/${id}/`)
    expect(prompt).toContain(`Asked of to-file at ${row.askedAt}, submitted 2028-03-02T09:14:40Z.`)
    const messages = JSON.parse(prompt)
    expect(messages[1].content).toMatch(/^\[The conversation was flushed\]/)
    expect(messages.map(message => message.content)).not.toContain('ask the file')
    expect(interactionsIn(ws).find(one => one.id === id)).toMatchObject({ state: 'submitted', processed: 1 })
  }, 40_000)
})
