import { describe, it, expect, beforeEach, afterEach, onTestFinished } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createModelServer, testSocket, startGate, suppliedKey } from './fixtures/model-server.js'
import { outsideWorkspace } from './fixtures/outside-ws.js'
import { readLock, readTurns } from '../src/core/spore-dir.js'
import { send } from '../src/core/send.js'
import { RUNNING, stateOf, stop } from '../src/core/state.js'

const SPAWN = resolve(dirname(fileURLToPath(import.meta.url)), '../native/spore-spawn')

let ws
let gate

const until = async (done, limitMs = 15000) => {
  const deadline = Date.now() + limitMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('waited too long')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const ticking = {
  use: (modelId) => ({
    id: modelId,
    info: () => ({ contextTokenLimit: 200000 }),
    answer: async () => ({
      status: 'tool_use',
      output: '',
      toolCalls: [{ id: 'c1', name: 'wsexec', arguments: { command: 'while :; do date +%s%N > data/tick.txt; echo .; sleep 0.05; done', out: 'data/loop.log' } }],
      cost: 0.01
    })
  })
}

beforeEach(async () => {
  ws = outsideWorkspace('forced-stop')
  gate = await startGate({ mo: ticking, name: 'forced-stop' })
})

afterEach(async () => {
  await gate.close()
  rmSync(ws, { recursive: true, force: true })
})

describe('an agent that will not stop', () => {
  it('is killed with the tools it started, so nothing outlives the lock', { timeout: 30000 }, async () => {
    send(ws, 'tick', { env: { PATH: process.env.PATH, HOME: process.env.HOME } })
    const tick = resolve(ws, 'data/tick.txt')
    await until(() => existsSync(tick))

    // Frozen, it can no longer run the abort handler that stops its tools' process groups.
    const runner = readLock(ws).pid
    const agent = Number(readFileSync(`/proc/${runner}/task/${runner}/children`, 'utf8').trim().split(/\s+/)[0])
    process.kill(agent, 'SIGSTOP')
    expect(stop(ws).stopped).toBe(true)
    await until(() => stateOf(ws).state !== RUNNING)

    const [turn] = readTurns(ws)
    expect(turn.error).toBe('KILLED')
    expect(turn.stopReason).toBe('cancelled')
    const settled = readFileSync(tick, 'utf8')
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(readFileSync(tick, 'utf8')).toBe(settled)
  })
})

describe('a cell that is stopped', () => {
  it('stops its tools before its lock is let go', { timeout: 30000 }, async () => {
    mkdirSync(resolve(ws, 'precursors'), { recursive: true })
    writeFileSync(resolve(ws, 'precursors/ticker.cmk'),
      '---\nname: ticker\ntools: [wsexec]\nrounds: [4, 6]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: keep\n---\n\nYou tick.\n')
    const cell = resolve(ws, 'data/cell')
    mkdirSync(cell, { recursive: true })
    writeFileSync(resolve(cell, 'in.md'), 'tick')
    // Started as an agent starts one, so the model socket is one standing where the runner's would.
    const socket = createModelServer({ mo: ticking, socketPath: testSocket('forced-stop-cell'), key: suppliedKey(ws) })
    await socket.listen()
    onTestFinished(() => socket.close())

    const started = spawn(SPAWN, ['--precursor', 'ticker', '--ws', 'data/cell', '--prompt', 'in.md', '--answer', 'data/out.txt', '--detach'], {
      cwd: ws,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, MODEL: 'anthropic/claude-haiku-4-5', SPORE_MODEL_SOCKET: socket.socketPath },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    started.stdout.on('data', chunk => { out += chunk })
    await once(started, 'close')
    const { pid } = JSON.parse(out.trim())
    const tick = resolve(cell, 'data/tick.txt')
    await until(() => existsSync(tick))

    process.kill(pid, 'SIGTERM')
    await until(() => !readLock(cell)?.pid)

    const settled = readFileSync(tick, 'utf8')
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(readFileSync(tick, 'utf8')).toBe(settled)
    expect(readTurns(cell)[0].stopReason).toBe('cancelled')
  })
})
