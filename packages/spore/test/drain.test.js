/**
 * A turn stopped while its call is running, on the runner's own session pool: the runner
 * reads the call to its end, counts it, and only then writes the turn down and lets go of
 * the workspace (ARCHITECTURE §The model broker). The session is scripted, the runner and the agent are
 * real.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { callEmbedding } from 'mohdel/client'

import { takeSlot } from '../src/core/admission.js'
import { CONFIG_FILE } from '../src/library/config.js'
import { enqueue, readLock, readTreeKey, readPending, readTurns } from '../src/core/spore-dir.js'
import { stateOf, stop } from '../src/core/state.js'
import { KEY_HEADER } from '../src/infra/socket-request.js'
import { outsideRoot, outsideWorkspace } from './fixtures/outside-ws.js'

const RUNNER = resolve(dirname(fileURLToPath(import.meta.url)), '../native', process.arch, 'spore-runner')
const CHATGPT_HELPER = createRequire(import.meta.url).resolve('mohdel/chatgpt/bin')

let root
let ws
let marks

const until = async (done, limitMs = 15000) => {
  const deadline = Date.now() + limitMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('waited too long')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const session = (marks) => `
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
const mark = (what) => appendFileSync(${JSON.stringify(marks)}, JSON.stringify({ what, at: Date.now() }) + '\\n')
const write = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
const now = () => String(process.hrtime.bigint())
createInterface({ input: process.stdin }).on('line', (line) => {
  const asked = JSON.parse(line)
  if (asked.op === 'ping') return write({ op: 'pong' })
  if (asked.op === 'info') return write({ type: 'info_done', result: { contextTokenLimit: 200000, turnTokenBase: 12000 } })
  if (asked.op === 'embed') {
    mark('embedded')
    const at = now()
    return write({ type: 'embed_done', result: { status: 'completed', vectors: [[0.5]], dimensions: 1, inputType: null, inputTokens: 1, cost: 0.03, timestamps: { start: at, first: at, end: at } } })
  }
  if (asked.op) return
  mark('started')
  const start = now()
  let sent = 0
  const tick = setInterval(() => {
    if (++sent < 15) return write({ type: 'delta', delta: { type: 'message', delta: 'tok ' } })
    clearInterval(tick)
    mark('finished')
    write({ type: 'done', result: { status: 'completed', output: 'late', inputTokens: 10, outputTokens: 15, thinkingTokens: 0, cost: 0.05, timestamps: { start, first: start, end: now() } } })
  }, 100)
})
`

const said = () => existsSync(marks) ? readFileSync(marks, 'utf8').split('\n').slice(0, -1).map(line => JSON.parse(line)) : []

// The root's one call starts a detached cell and then keeps its agent busy in a tool, so the
// runner's single session is free for the cell's call, which is slow. The prompt tells them
// apart: only the cell's carries the task its directory was given.
const cellSession = (marks) => `
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
const mark = (what) => appendFileSync(${JSON.stringify(marks)}, JSON.stringify({ what, at: Date.now() }) + '\\n')
const write = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
const now = () => String(process.hrtime.bigint())
createInterface({ input: process.stdin }).on('line', (line) => {
  const asked = JSON.parse(line)
  if (asked.op === 'ping') return write({ op: 'pong' })
  if (asked.op === 'info') return write({ type: 'info_done', result: { contextTokenLimit: 200000, turnTokenBase: 12000 } })
  if (asked.op) return
  const start = now()
  if (!line.includes('CELL-TASK')) {
    mark('root')
    const command = 'mkdir -p data/cell && echo CELL-TASK > data/cell/in.md && "$SPORE_SPAWN" --precursor summarize --ws data/cell --prompt in.md --answer data/out.txt --detach && sleep 30'
    return write({ type: 'done', result: { status: 'tool_use', output: null, inputTokens: 10, outputTokens: 5, thinkingTokens: 0, cost: 0.01, timestamps: { start, first: start, end: now() }, toolCalls: [{ id: 'c1', name: 'wsexec', arguments: { command, out: 'data/spawn.txt', timeout: 60 } }] } })
  }
  mark('cell-started')
  let sent = 0
  const tick = setInterval(() => {
    if (++sent < 15) return write({ type: 'delta', delta: { type: 'message', delta: 'tok ' } })
    clearInterval(tick)
    mark('cell-finished')
    write({ type: 'done', result: { status: 'completed', output: '- one point', inputTokens: 10, outputTokens: 15, thinkingTokens: 0, cost: 0.07, timestamps: { start, first: start, end: now() } } })
  }, 100)
})
`

const startTurn = (source = session(marks), extra = []) => {
  const script = resolve(root, 'session.mjs')
  writeFileSync(script, source)
  const slot = takeSlot(CONFIG_FILE)
  const err = openSync(resolve(ws, 'spore.err'), 'a')
  enqueue(ws, 'go')
  try {
    spawn(RUNNER, ['--ws', ws, '--slot', slot.path, '--node', process.execPath, '--session', script, '--chatgpt-helper', CHATGPT_HELPER, ...extra], {
      detached: true,
      stdio: ['ignore', 'ignore', err, slot.fd],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_CONFIG_HOME: root, OPENAI_API_SK: 'fake' }
    }).unref()
  } finally {
    closeSync(slot.fd)
    closeSync(err)
  }
}

const untilLetGo = async () => {
  let drained = false
  let freedAt = null
  await until(() => {
    if (stateOf(ws).draining) drained = true
    if (!readLock(ws)?.pid) freedAt = Date.now()
    return freedAt !== null
  })
  return { drained, freedAt }
}

// The model socket a turn is served on is in its agent's environment and nowhere else.
const agentsModelSocket = () => {
  const runner = readLock(ws).pid
  const children = readFileSync(`/proc/${runner}/task/${runner}/children`, 'utf8').trim().split(/\s+/)
  const agent = children.find(pid => readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('spore-agent.js'))
  const env = readFileSync(`/proc/${agent}/environ`, 'utf8').split('\0')
  return env.find(entry => entry.startsWith('SPORE_MODEL_SOCKET=')).slice('SPORE_MODEL_SOCKET='.length)
}

beforeEach(() => {
  root = outsideRoot('drain')
  ws = outsideWorkspace('drain-ws', 'openai/slow')
  marks = resolve(root, 'marks.jsonl')
})

afterEach(async () => {
  if (readLock(ws)?.pid) {
    stop(ws)
    await untilLetGo()
  }
  rmSync(root, { recursive: true, force: true })
  rmSync(ws, { recursive: true, force: true })
})

describe('a turn stopped while its call runs', () => {
  it('pays for the whole call, and holds the workspace until it has', { timeout: 30000 }, async () => {
    startTurn()
    await until(() => said().some(m => m.what === 'started'))
    expect(stop(ws).stopped).toBe(true)

    const { drained, freedAt } = await untilLetGo()

    const finished = said().find(m => m.what === 'finished')
    expect(drained, readFileSync(resolve(ws, 'spore.err'), 'utf8')).toBe(true)
    expect(finished).toBeDefined()
    expect(freedAt).toBeGreaterThanOrEqual(finished.at)
    const [turn] = readTurns(ws)
    expect(turn).toMatchObject({ stopReason: 'cancelled', ownMicros: 50000, treeMicros: 50000 })
    expect(turn).toMatchObject({ workUnits: 2, workUnitsOwn: 1, workUnitsChildren: 0 })
    expect(readPending(ws)).toBeNull()
  })

  it('drops an embedding still waiting for a session, which never starts', { timeout: 30000 }, async () => {
    startTurn(session(marks), ['--model-sessions', '1'])
    await until(() => said().some(m => m.what === 'started'))
    const embedding = callEmbedding(
      { callId: randomUUID(), authId: 'spore', model: 'openai/slow', input: ['a'] },
      { socketPath: agentsModelSocket(), headers: { [KEY_HEADER]: readTreeKey(ws) } }
    )
    const settled = embedding.then(() => 'answered', () => 'dropped')
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(stop(ws).stopped).toBe(true)

    await untilLetGo()

    expect(await settled).toBe('dropped')
    expect(said().map(m => m.what)).toEqual(['started', 'finished'])
    const [turn] = readTurns(ws)
    expect(turn).toMatchObject({ stopReason: 'cancelled', treeMicros: 50000 })
  })
})

describe('calls made at once in a turn', () => {
  it('get a session each instead of waiting for the one in use', { timeout: 30000 }, async () => {
    startTurn()
    await until(() => said().some(m => m.what === 'started'))
    const embedding = await callEmbedding(
      { callId: randomUUID(), authId: 'spore', model: 'openai/slow', input: ['a'] },
      { socketPath: agentsModelSocket(), headers: { [KEY_HEADER]: readTreeKey(ws) } }
    ).then(() => 'answered', () => 'dropped')
    expect(embedding).toBe('answered')
    expect(said().map(m => m.what)).toEqual(['started', 'embedded'])
    expect(stop(ws).stopped).toBe(true)
    await untilLetGo()
  })
})

describe('a turn that ends while a detached cell\'s call runs', () => {
  it('counts the cell\'s call in the turn\'s tree once the runner has read it to its end', { timeout: 30000 }, async () => {
    mkdirSync(resolve(ws, 'precursors'))
    copyFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/plugins/docs/precursors/summarize.cmk'), resolve(ws, 'precursors/summarize.cmk'))
    startTurn(cellSession(marks))
    await until(() => said().some(m => m.what === 'cell-started'))
    expect(stop(ws).stopped).toBe(true)

    const { freedAt } = await untilLetGo()

    const finished = said().find(m => m.what === 'cell-finished')
    expect(finished, readFileSync(resolve(ws, 'spore.err'), 'utf8')).toBeDefined()
    expect(freedAt).toBeGreaterThanOrEqual(finished.at)
    const [turn] = readTurns(ws)
    expect(turn.stopReason).toBe('cancelled')
    expect(turn.ownMicros).toBe(10000)
    expect(turn.treeMicros).toBe(80000)
    expect(turn.workUnitsChildren).toBe(1)
    expect(turn.byPrecursor).toEqual({ summarize: { micros: 70000, rounds: 1 } })
  })
})
