/**
 * A cairn written and read from real turns: the cairn plugin's service holding the record, the
 * runner's source broker carrying the writes, and `$SPORE_CAIRN` run by a confined agent. Only the
 * model's replies are scripted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { startGate } from './fixtures/model-server.js'
import { outsideRoot, outsideWorkspace } from './fixtures/outside-ws.js'
import { answers, calls, scriptedMo } from './fixtures/scripted-model.js'
import { containCheck } from '../src/core/command.js'
import { allowPlugin } from '../src/core/plugins.js'
import { readTurns } from '../src/core/spore-dir.js'

const run = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const SPORE = resolve(__dirname, '../../spore-cli/bin/spore.js')
const SERVICE = join(dirname(createRequire(import.meta.url).resolve('@rhizogrip/spore-plugin-cairn/package.json')), 'bin', 'spore-cairn.js')
const CONTAINED = containCheck().contained

let ws
let root
let gate
let service
let script

const env = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME })
const config = (...path) => join(process.env.XDG_CONFIG_HOME, 'spore', ...path)
const db = () => join(root, 'ledger', 'cairn.sqlite')

const spore = async (prompt) => {
  try {
    const { stdout, stderr } = await run(process.execPath, [SPORE, 'send', ws, prompt], { env: env() })
    return { code: 0, stdout, stderr }
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr }
  }
}

const serve = async () => {
  const child = spawn(process.execPath, [SERVICE, 'ledger'], { env: env() })
  let said = ''
  await new Promise((resolve, reject) => {
    child.stderr.on('data', (chunk) => {
      said += chunk
      if (said.includes('serving')) resolve()
    })
    child.once('exit', (code) => reject(new Error(`spore-cairn exited ${code}: ${said}`)))
  })
  return child
}

const stopped = (child, signal) => {
  const exited = new Promise(resolve => child.once('exit', (code, sig) => resolve(code ?? sig)))
  child.kill(signal)
  return exited
}

const rows = (file) => readFileSync(join(ws, 'data', file), 'utf8').trim().split('\n').map(line => JSON.parse(line))

const journal = () => {
  const reader = new DatabaseSync(db(), { readOnly: true })
  const { journal_mode: mode } = reader.prepare('PRAGMA journal_mode').get()
  reader.close()
  return mode
}

beforeEach(async () => {
  ws = outsideWorkspace('cairn-turn')
  root = outsideRoot('cairn')
  mkdirSync(join(root, 'ledger'))
  script = []
  gate = await startGate({ mo: scriptedMo(async () => script.shift()), name: 'cairn-turn' })
  allowPlugin('cairn', [`root=${root}`], { configFile: config('config.json') })

  mkdirSync(config('cairn'), { recursive: true })
  writeFileSync(config('cairn', 'ledger.json'), JSON.stringify({
    members: { [basename(ws)]: 'writer' },
    kinds: { note: { text: 'string' } },
    subjects: {}
  }))
  writeFileSync(config('environment'), 'CAIRN_LEDGER_TOKEN=t0k\n')
  writeFileSync(config('sources.json'), JSON.stringify({
    'cairn-ledger': {
      url: 'http://cairn/',
      socket: join(root, 'sockets', 'ledger.sock'),
      methods: ['POST'],
      paths: ['append', 'evidence'],
      headers: {
        Authorization: 'Bearer ${CAIRN_LEDGER_TOKEN}', // eslint-disable-line no-template-curly-in-string
        'X-Cairn-Actor': '{name}',
        'X-Cairn-Via': 'agent',
        'X-Cairn-Id': '{turn}',
        'X-Cairn-Hop': '0'
      }
    }
  }))
  writeFileSync(join(ws, 'spore.cmk'), readFileSync(join(ws, 'spore.cmk'), 'utf8')
    .replace(/^---\n/, `---\nplugins: [cairn]\nreads: [cairn-ledger=${join(root, 'ledger')}]\nsources: [cairn-ledger]\n`))
  service = await serve()
})

afterEach(async () => {
  if (service.exitCode === null && service.signalCode === null) await stopped(service, 'SIGKILL')
  await gate.close()
  rmSync(ws, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

describe('a cairn written from a turn', () => {
  it('stamps the spore and the turn the runner knows, whatever the agent sends (A5)', async () => {
    const forged = JSON.stringify({ kind: 'note', at: new Date().toISOString(), refs: {}, data: { text: 'forged' }, actor: { name: 'someone-else' } })
    script.push(
      calls('exec', { command: '"$SPORE_CAIRN" ledger append note --data \'{"text":"from the turn"}\'', out: 'data/appended.json' }),
      calls('exec', { command: `printf '%s' '${forged}' | node "$SPORE_SOURCE" cairn-ledger --method POST --path append --body - --out -`, out: 'data/forged.json' }),
      calls('exec', { command: 'printenv CAIRN_LEDGER_TOKEN || echo none', out: 'data/token.txt' }),
      answers('wrote')
    )
    const wrote = await spore('write it down')
    expect(wrote.code, wrote.stderr).toBe(0)
    expect(JSON.parse(readFileSync(join(ws, 'data', 'appended.json'), 'utf8'))).toMatchObject({ seq: 2 })
    expect(JSON.parse(readFileSync(join(ws, 'data', 'forged.json'), 'utf8')).error).toMatchObject({ type: 'shape-mismatch', detail: '$.actor' })
    expect(readFileSync(join(ws, 'data', 'token.txt'), 'utf8')).toBe('none\n')

    const [turn] = readTurns(ws)
    const reader = new DatabaseSync(db(), { readOnly: true })
    const written = reader.prepare("SELECT seq, actor, role, via, id, hop, data FROM entries WHERE kind = 'note'").all().map(row => ({ ...row }))
    reader.close()
    expect(written).toEqual([{ seq: 2, actor: basename(ws), role: 'writer', via: 'agent', id: turn.turnId, hop: 0, data: '{"text":"from the turn"}' }])
  })
})

describe('a cairn seen from a contained turn', () => {
  it.skipIf(!CONTAINED)('has no socket there to connect to (A6)', async () => {
    const socket = join(root, 'sockets', 'ledger.sock')
    const connect = `require('node:net').connect(${JSON.stringify(socket)}).on('connect', () => console.log('connected')).on('error', (err) => console.log(err.code))`
    script.push(
      calls('exec', { command: `test -e ${socket} && echo present || echo absent; node -e ${JSON.stringify(connect)}`, out: 'data/socket.txt' }),
      answers('looked')
    )
    const looked = await spore('look for the socket')
    expect(looked.code, looked.stderr).toBe(0)
    expect(readFileSync(join(ws, 'data', 'socket.txt'), 'utf8')).toBe('absent\nENOENT\n')
    expect(existsSync(socket)).toBe(true)
  })
})

describe('a cairn read by a confined agent (A12)', () => {
  const read = (file) => calls('exec', { command: '"$SPORE_CAIRN" ledger --json \'SELECT seq, kind FROM entries ORDER BY seq\'', out: `data/${file}` })
  const expected = [{ seq: 1, kind: 'cairn.config' }, { seq: 2, kind: 'note' }]

  it('reads it while the daemon holds it, after the daemon stopped, and after it was killed', async () => {
    script.push(
      calls('exec', { command: '"$SPORE_CAIRN" ledger append note --data \'{"text":"one"}\'', out: 'data/appended.json' }),
      read('held.jsonl'),
      answers('held')
    )
    const held = await spore('append, then read')
    expect(held.code, held.stderr).toBe(0)
    expect(rows('held.jsonl')).toEqual(expected)

    expect(await stopped(service, 'SIGTERM')).toBe(0)
    expect(journal()).toBe('delete')
    expect(existsSync(`${db()}-wal`)).toBe(false)
    script.push(read('stopped.jsonl'), answers('stopped'))
    const afterStop = await spore('read it with nobody holding it')
    expect(afterStop.code, afterStop.stderr).toBe(0)
    expect(rows('stopped.jsonl')).toEqual(expected)

    service = await serve()
    expect(await stopped(service, 'SIGKILL')).toBe('SIGKILL')
    expect(existsSync(`${db()}-wal`)).toBe(true)
    script.push(read('killed.jsonl'), answers('killed'))
    const afterKill = await spore('read it after the daemon was killed')
    expect(afterKill.code, afterKill.stderr).toBe(0)
    expect(rows('killed.jsonl')).toEqual(expected)
  })
})
