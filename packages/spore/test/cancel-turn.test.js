/**
 * Stopping a turn that has a cell under it.
 *
 * `cancel-tree.test.js` establishes that aborting a tool kills the process group it
 * started, including a grandchild that ignores SIGTERM. What it does not cover is the
 * turn: a signal arriving at `spore`, an agent that is mid-inference with a cell of its
 * own running, and what has to be true afterwards — a terminal record, a released lock,
 * a supervisor that cleaned up rather than one that was killed with its socket still in
 * place.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createModelServer, suppliedKey } from './fixtures/model-server.js'
import { brokerSocketPath } from '../src/infra/broker-socket.js'
import { readTurns } from '../src/core/spore-dir.js'
import { outsideWorkspace } from './fixtures/outside-ws.js'
import { answers, calls, scriptedMo } from './fixtures/scripted-model.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SPORE = resolve(__dirname, '../../spore-cli/bin/spore.js')
const SPAWN = resolve(__dirname, '../native/spore-spawn')

let ws
let broker
let mo

const env = () => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  MODEL: 'anthropic/claude-haiku-4-5',
  SPORE_MODEL_SOCKET: broker.socketPath,
  SPORE_SPAWN: SPAWN
})

const until = async (condition, ms = 15_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await condition()) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}

const start = async (reply) => {
  mo = scriptedMo(reply)
  broker = createModelServer({ mo, socketPath: brokerSocketPath('cancel-turn'), limit: 10, key: suppliedKey(ws) })
  await broker.listen()
}

const held = (dir) => existsSync(resolve(dir, 'lock')) && readFileSync(resolve(dir, 'lock'), 'utf8').trim() !== ''

// What a lock file still naming a holder means: a supervisor still running, or one killed before
// it could clear the file, which the kernel's own lock no longer counts.
const holderOf = (dir) => {
  const pid = readFileSync(resolve(dir, 'lock'), 'utf8').trim()
  const alive = existsSync(`/proc/${pid}`)
  const what = alive ? readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() : 'gone'
  const frames = existsSync(resolve(dir, 'spawn.json')) ? readFileSync(resolve(dir, 'spawn.json'), 'utf8').trim().split('\n') : []
  return `the cell's lock still names pid ${pid} (${alive ? `running: ${what}` : 'gone, so killed before clearing it'}); its last frame: ${frames.at(-1) ?? 'none'}; its last turn: ${readTurns(dir).at(-1)?.stopReason ?? 'none recorded'}`
}

beforeEach(() => {
  ws = outsideWorkspace('cancel-turn')
  mkdirSync(resolve(ws, 'precursors'), { recursive: true })
  writeFileSync(resolve(ws, 'precursors/worker.cmk'),
    '---\nname: worker\ntools: [read, write]\nrounds: [4, 6]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: keep\n---\n\nYou answer with the result.\n')
})

afterEach(async () => {
  await broker?.close()
  broker = null
  rmSync(ws, { recursive: true, force: true })
})

describe('a turn stopped from outside', () => {
  it('records how it ended, releases the lock, and takes its cell with it', async () => {
    // The spore stages a cell, starts it, and is still waiting when the signal arrives. The
    // cell's own model call never returns, so everything below is about the stopping.
    await start(async (input, round) => {
      const asked = String(input.find(m => m.role === 'user')?.content ?? '')
      if (asked.includes('cell work')) return new Promise(() => {})
      if (round === 0) return calls('write', { path: 'data/cell/in.md', content: 'cell work' })
      if (round === 1) return calls('wsexec', { command: `"${SPAWN}" --precursor worker --ws data/cell --prompt in.md --answer data/out.txt`, out: 'data/spawn.log' })
      return answers('never reached')
    })

    const child = spawn(process.execPath, [SPORE, 'send', ws, 'delegate this'], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] })

    // Wait until the cell is actually running: its workspace holds a start frame and
    // its lock is held. Signalling before that would test a different thing.
    const cell = resolve(ws, 'data/cell')
    expect(await until(async () => existsSync(resolve(cell, 'spawn.json')) && held(cell))).toBe(true)

    // `spore send` only follows the turn now, so killing it walks away rather than
    // cancelling. Stopping is its own verb, and it reaches the runner through the lock.
    const stopper = spawn(process.execPath, [SPORE, 'stop', ws], { env: env(), stdio: 'ignore' })
    await once(stopper, 'close')
    const [code] = await once(child, 'close')
    // No answer, so the turn is a failure to its caller — but a recorded one.
    expect(code).toBe(1)

    const [turn] = readTurns(ws)
    expect(turn.stopReason).toBe('cancelled')
    expect(turn.concluded).toBe(false)
    // The lock at both levels is free: the cell's supervisor took the signal and
    // cleaned up rather than being killed with its lock still held.
    expect(held(ws)).toBe(false)
    const freed = await until(async () => !held(cell))
    expect(freed, freed ? '' : holderOf(cell)).toBe(true)

    // The cell took the stop as its turn's abort, so it says how it ended rather than
    // being left looking as though it were still running.
    const frame = JSON.parse(readFileSync(resolve(cell, 'spawn.json'), 'utf8').trim().split('\n').at(-1))
    expect(frame.stopReason).toBe('cancelled')
    expect(frame.answer).toBeNull()
    expect(readTurns(cell).at(-1).stopReason).toBe('cancelled')
    expect(existsSync(resolve(cell, 'data/out.txt'))).toBe(false)

    // And nothing is still talking to the broker: a cell that outlived the turn would
    // keep spending against a ledger nobody is watching any more.
    const seen = mo.seen.length
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(mo.seen.length).toBe(seen)
  })

  it('cleans up after a detached cell when the pid it printed is signalled', async () => {
    await start(async () => new Promise(() => {}))
    mkdirSync(resolve(ws, 'data/detached'), { recursive: true })
    writeFileSync(resolve(ws, 'data/detached/in.md'), 'slow work')

    const started = spawn(SPAWN, [
      '--precursor', 'worker', '--ws', 'data/detached', '--prompt', 'in.md', '--answer', 'data/out.txt', '--detach'
    ], { cwd: ws, env: env(), stdio: ['ignore', 'pipe', 'pipe'] })

    let out = ''
    started.stdout.on('data', chunk => { out += chunk })
    await once(started, 'close')
    const frame = JSON.parse(out.trim())
    expect(frame.detached).toBe(true)

    const cell = resolve(ws, 'data/detached')
    expect(await until(async () => held(cell))).toBe(true)

    // Detached, this pid is the only handle a caller has — which is why the supervisor
    // takes the signal rather than leaving the kernel to reap it mid-write.
    process.kill(frame.pid, 'SIGTERM')
    expect(await until(async () => !held(cell))).toBe(true)
    expect(existsSync(resolve(cell, 'data/out.txt'))).toBe(false)
  })
})
