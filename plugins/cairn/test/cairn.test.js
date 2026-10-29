import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import http from 'node:http'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { openCairn, readInstance, serve } from '@rhizogrip/cairn'
import { define, showPlugin } from '@rhizogrip/spore'
import { definitionWith, outsideRoot } from '@rhizogrip/spore/testing'

const run = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SPORE = dirname(createRequire(join(ROOT, 'package.json')).resolve('@rhizogrip/spore/package.json'))
const SOURCE_BIN = join(SPORE, 'bin', 'source.js')
const SQL_BIN = join(SPORE, 'bin', 'sql.js')
const OUTSIDE = process.env.SPORE_TEST_DIR || resolve(ROOT, '../../../tmp/spore-tests')

const INSTANCE = {
  members: { alice: 'writer', bob: 'writer' },
  kinds: { note: { text: 'string', 'tag?': 'string' } },
  subjects: { entry: 'seq', file: 'sha256' }
}

const answer = (status, body) => ({ status, ok: status >= 200 && status < 300, contentType: 'application/json', bodyBase64: Buffer.from(body).toString('base64') })

function asked (socketPath, { method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('the cairn plugin', () => {
  it('is a plugin spore accepts, giving its program, hiding its sockets and offering its service', () => {
    const shown = showPlugin('cairn', { configFile: join(ROOT, 'no-config.json') })
    expect(shown).toMatchObject({
      package: '@rhizogrip/spore-plugin-cairn',
      settings: { root: 'text' },
      programs: { SPORE_CAIRN: join(shown.dir, 'bin/cairn.js') },
      contain: { hide: '{settings.root}/sockets' },
      services: ['cairn']
    })
  })

  it('ships an example whose instance file the service takes', () => {
    const { members, subjects, notify } = readInstance(join(ROOT, 'examples', 'tasks', 'tasks.json'))
    expect(Object.keys(members)).toEqual(['lead', 'worker'])
    expect(subjects).toEqual(new Map([['task', 'seq'], ['report', 'sha256']]))
    expect(notify).toEqual({ minDelayMs: 60_000, maxHops: 2 })
  })
})

describe('$SPORE_CAIRN', () => {
  let dir
  let daemon
  let broker
  let forwarded

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'spore-cairn-'))
    const root = join(dir, 'root')
    mkdirSync(join(root, 'ledger'), { recursive: true })
    mkdirSync(join(root, 'sockets'), { mode: 0o700 })
    writeFileSync(join(dir, 'ledger.json'), JSON.stringify(INSTANCE))
    const socket = join(root, 'sockets', 'ledger.sock')
    daemon = await serve({ name: 'ledger', instanceFile: join(dir, 'ledger.json'), file: join(root, 'ledger', 'cairn.sqlite'), socket, token: 't0k' })

    const ws = join(dir, 'alice')
    mkdirSync(join(ws, 'data'), { recursive: true })
    writeFileSync(join(ws, 'tree.key'), 'k'.repeat(64))
    symlinkSync(join(root, 'ledger'), join(ws, 'cairn-ledger'))

    forwarded = []
    broker = http.createServer((req, res) => {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', async () => {
        const call = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        forwarded.push(call)
        const said = await asked(socket, {
          method: call.method,
          path: `/${call.path}`,
          headers: { authorization: 'Bearer t0k', 'x-cairn-actor': 'alice', 'x-cairn-via': 'agent', 'x-cairn-id': 'turn-1', 'x-cairn-hop': '0' },
          body: JSON.stringify(call.body)
        })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(answer(said.status, said.body)))
      })
    })
    await new Promise(resolve => broker.listen(join(dir, 'source.sock'), resolve))
  })

  afterEach(async () => {
    await new Promise(resolve => broker.close(resolve))
    await daemon.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const cairn = (args) => new Promise((resolve) => {
    execFile(process.execPath, [join(ROOT, 'bin/cairn.js'), ...args], {
      cwd: join(dir, 'alice'),
      env: { PATH: process.env.PATH, SPORE_WS: join(dir, 'alice'), SPORE_SQL: SQL_BIN, SPORE_SOURCE: SOURCE_BIN, SPORE_SOURCE_SOCKET: join(dir, 'source.sock') }
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }))
  })

  it('appends through the source, the runner saying who wrote', async () => {
    const wrote = await cairn(['ledger', 'append', 'note', '--data', '{"text":"payouts checked"}'])
    expect(wrote.code).toBe(0)
    expect(JSON.parse(wrote.stdout)).toMatchObject({ seq: 2 })
    expect(forwarded).toEqual([expect.objectContaining({ source: 'cairn-ledger', method: 'POST', path: 'append' })])

    const read = await cairn(['ledger', '--json', "SELECT kind, actor, role, via, id, data FROM entries WHERE kind = 'note'"])
    expect(read.code).toBe(0)
    expect(JSON.parse(read.stdout)).toEqual({ kind: 'note', actor: 'alice', role: 'writer', via: 'agent', id: 'turn-1', data: '{"text":"payouts checked"}' })
  })

  it('says what the cairn refused, and exits 1', async () => {
    const wrong = await cairn(['ledger', 'append', 'note', '--data', '{"text":7}'])
    expect(wrong.code).toBe(1)
    expect(wrong.stderr).toMatch(/refused, shape-mismatch: .*\$\.data\.text/)

    const stale = await cairn(['ledger', 'append', 'note', '--data', '{"text":"late"}', '--expected-head', '0'])
    expect(stale.code).toBe(1)
    expect(stale.stderr).toMatch(/refused, stale-head: the head is 1, not 0/)
  })

  it('refuses what it cannot send, before asking anything', async () => {
    expect((await cairn(['ledger', 'append', 'note', '--data', '{text}'])).code).toBe(2)
    expect((await cairn(['ledger', 'append', 'note', '--expected-head', 'one'])).code).toBe(2)
    expect((await cairn(['ledger', 'append'])).code).toBe(2)
    expect((await cairn(['elsewhere', '.tables'])).stderr).toMatch(/elsewhere is no cairn this spore reads/)
    expect(forwarded).toEqual([])
  })

  it('stores evidence, which an entry then cites by its hash', async () => {
    writeFileSync(join(dir, 'alice', 'data', 'report.txt'), 'the report')
    const stored = await cairn(['ledger', 'evidence', 'data/report.txt'])
    expect(stored.code).toBe(0)
    const { sha256, bytes } = JSON.parse(stored.stdout)
    expect(bytes).toBe(10)
    const cited = await cairn(['ledger', 'append', 'note', '--refs', JSON.stringify({ file: sha256 }), '--data', '{"text":"see the report"}'])
    expect(cited.code).toBe(0)
    const read = await cairn(['ledger', '--json', 'SELECT key, value FROM subjects WHERE key = \'file\''])
    expect(JSON.parse(read.stdout)).toEqual({ key: 'file', value: sha256 })
  })

  it('lists the cairns this spore reads, with their heads', async () => {
    await cairn(['ledger', 'append', 'note', '--data', '{"text":"one"}'])
    const listed = await cairn(['list'])
    expect(listed.code).toBe(0)
    expect(listed.stdout).toMatch(/^ledger {2}2 entries, the last at \d{4}-\d\d-\d\dT[\d:.]+Z\n$/)
  })
})

describe('the cairn service', () => {
  let dir
  let env
  let root
  let configFile

  beforeEach(() => {
    dir = outsideRoot('cairn', OUTSIDE)
    root = join(dir, 'root')
    const config = join(dir, 'config', 'spore')
    configFile = join(config, 'config.json')
    mkdirSync(join(config, 'cairn'), { recursive: true })
    writeFileSync(configFile, JSON.stringify({ plugins: { cairn: { settings: { root }, version: '0.1.0', dir: realpathSync(ROOT) } } }))
    writeFileSync(join(config, 'cairn', 'ledger.json'), JSON.stringify(INSTANCE))
    writeFileSync(join(config, 'environment'), 'CAIRN_LEDGER_TOKEN=t0k\n')
    writeFileSync(join(config, 'sources.json'), JSON.stringify({ 'cairn-ledger': { url: 'http://cairn/', socket: join(root, 'sockets', 'ledger.sock') } }))
    env = { PATH: process.env.PATH, HOME: process.env.HOME, XDG_CONFIG_HOME: join(dir, 'config'), XDG_STATE_HOME: join(dir, 'state') }
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const service = (...args) => run(process.execPath, [join(ROOT, 'bin/spore-cairn.js'), ...args], { env }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (err) => ({ code: err.code, stdout: err.stdout, stderr: err.stderr })
  )

  const spore = (name, grants) => {
    mkdirSync(join(root, 'ledger'), { recursive: true })
    const definition = join(dir, `${name}.cmk`)
    writeFileSync(definition, definitionWith('anthropic/claude-haiku-4-5').replace(/^---\n/, `---\n${grants}\n`))
    define({ ws: join(dir, 'spores', name), definition, configFile })
  }

  it('serves the cairn its instance file describes, its sockets kept to this user', async () => {
    const child = spawn(process.execPath, [join(ROOT, 'bin/spore-cairn.js'), 'ledger'], { env })
    let said = ''
    await new Promise((resolve, reject) => {
      child.stderr.on('data', (chunk) => {
        said += chunk
        if (said.includes('serving')) resolve()
      })
      child.on('exit', (code) => reject(new Error(`exited ${code}: ${said}`)))
    })
    expect(statSync(join(root, 'sockets')).mode & 0o777).toBe(0o700)
    expect(statSync(join(root, 'sockets', 'ledger.sock')).mode & 0o777).toBe(0o600)

    const second = await service('ledger')
    expect(second.code).toBe(2)
    expect(second.stderr).toMatch(/is served by another daemon/)

    const stopped = new Promise(resolve => child.on('exit', resolve))
    child.kill('SIGTERM')
    expect(await stopped).toBe(0)
    const cairn = openCairn(join(root, 'ledger', 'cairn.sqlite'), { name: 'ledger' })
    expect(cairn.latest('cairn.config').data).toEqual(INSTANCE)
    cairn.close()
  })

  it('refuses to start, exiting 2, what it cannot serve', async () => {
    const without = await service('other')
    expect(without.code).toBe(2)
    expect(without.stderr).toMatch(/there is no .*cairn\/other\.json/)

    writeFileSync(join(dir, 'config', 'spore', 'cairn', 'other.json'), JSON.stringify(INSTANCE))
    const untokened = await service('other', '--check')
    expect(untokened.code).toBe(2)
    expect(untokened.stderr).toMatch(/CAIRN_OTHER_TOKEN is not set/)

    expect((await service('Ledger')).code).toBe(2)

    writeFileSync(configFile, JSON.stringify({ plugins: { cairn: { settings: { root: 'relative/root' }, version: '0.1.0', dir: realpathSync(ROOT) } } }))
    const relative = await service('ledger', '--check')
    expect(relative.code).toBe(2)
    expect(relative.stderr).toMatch(/root is relative\/root/)
  })

  it('warns of a member that cannot reach the cairn and of a spore that can and is not one', async () => {
    const read = `cairn-ledger=${join(root, 'ledger')}`
    spore('alice', `reads: [${read}]\nsources: [cairn-ledger]\nplugins: [cairn]`)
    spore('bob', `reads: [${read}]`)
    spore('eve', `reads: [${read}]\nsources: [cairn-ledger]`)

    const checked = await service('ledger', '--check')
    expect(checked.code).toBe(0)
    const warnings = checked.stderr.split('\n').filter(line => line.includes('warning: ')).map(line => line.slice(line.indexOf('warning: ') + 9))
    expect(warnings).toEqual([
      'bob is a member and is not granted the source cairn-ledger',
      'bob is a member and its plugins: does not name cairn',
      `eve reads ${join(root, 'ledger')} and is not a member of ledger`,
      'eve is granted the source cairn-ledger and is not a member of ledger'
    ])
  })

  it('warns when sources.json does not reach the socket it serves', async () => {
    writeFileSync(join(dir, 'config', 'spore', 'sources.json'), JSON.stringify({ 'cairn-ledger': { url: 'http://cairn/', socket: '/elsewhere.sock' } }))
    const checked = await service('ledger', '--check')
    expect(checked.code).toBe(0)
    expect(checked.stderr).toMatch(/cairn-ledger in .*sources\.json names the socket \/elsewhere\.sock, and ledger serves .*ledger\.sock/)
    expect(checked.stderr).toMatch(/alice is a member of ledger and no spore of this user is called alice/)
  })
})
