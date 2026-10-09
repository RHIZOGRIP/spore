import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { stateOf, stop } from '../src/core/state.js'
import { acquireLock, hostState, releaseLock, writePendingRecord, writeTurnRecords } from '../src/core/spore-dir.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '.state-workspaces')
const SPORE_DIR = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../src/core/spore-dir.js')).href

const held = []

const spore = (name, { turns = [], lock, running = false } = {}) => {
  const ws = resolve(ROOT, name)
  mkdirSync(ws, { recursive: true })
  writeFileSync(resolve(ws, 'spore.cmk'), '---\nname: spore\nmodel: anthropic/claude-haiku-4-5\nrounds: [1, 2]\ncost: [1, 2]\nwall: [1m, 2m]\n---\nbody\n')
  if (turns.length) writeTurnRecords(ws, turns.map(turn => ({ startedAt: '2026-09-27T00:00:00.000Z', ...turn })))
  if (lock !== undefined) writeFileSync(resolve(ws, 'lock'), lock)
  if (running) {
    acquireLock(ws)
    held.push(ws)
  }
  return ws
}

beforeEach(() => rmSync(ROOT, { recursive: true, force: true }))
afterEach(() => {
  for (const ws of held.splice(0)) releaseLock(ws)
  rmSync(ROOT, { recursive: true, force: true })
})

describe('what a spore is doing', () => {
  it('separates a live run from one that died holding its lock', () => {
    const live = spore('live', { running: true })
    const dead = spore('dead', { lock: JSON.stringify({ pid: 2 ** 22 + 7, startedAt: 'then' }) })
    expect(stateOf(live)).toMatchObject({ state: 'running', pid: process.pid })
    // A clean exit truncates the lock, so a pid still in it that nobody holds is a crash.
    expect(stateOf(dead).state).toBe('crashed')
  })

  it('reads a pid a crash left in the lock as a crash, even once that pid is alive again', () => {
    const reused = spore('reused', { lock: JSON.stringify({ pid: process.pid, startedAt: 'then' }) })
    expect(stateOf(reused)).toMatchObject({ state: 'crashed', pid: process.pid })
  })

  it('says a run whose turn has ended and is waiting on its calls is draining, with that turn as its last', () => {
    const running = spore('mid-turn', { turns: [{ stopReason: 'answer', concluded: true }], running: true })
    hostState(running)
    expect(stateOf(running)).toMatchObject({ state: 'running', last: { stopReason: 'answer' } })
    expect(stateOf(running).draining).toBeUndefined()

    const draining = spore('draining', { turns: [{ stopReason: 'answer', concluded: true }], running: true })
    writePendingRecord(draining, { stopReason: 'cancelled', concluded: false })
    expect(stateOf(draining)).toMatchObject({ state: 'running', draining: true, last: { stopReason: 'cancelled' } })
  })

  it('reads the last turn for a spore nobody is running', () => {
    const cases = [
      ['idle', { stopReason: 'answer', concluded: true }],
      ['waiting', { stopReason: 'question', concluded: true }],
      ['wrapped', { stopReason: 'soft:rounds', concluded: true }],
      ['halted', { stopReason: 'hard:cost', concluded: false }],
      ['cancelled', { stopReason: 'cancelled', concluded: false }]
    ]
    for (const [state, turn] of cases) {
      expect(stateOf(spore(state, { turns: [turn], lock: '' })).state).toBe(state)
    }
  })

  it('calls a spore that has never run idle', () => {
    expect(stateOf(spore('fresh')).state).toBe('idle')
  })

  it('adds up what its turns spent, cells included', () => {
    expect(stateOf(spore('spent', { turns: [{ ownMicros: 20_000, treeMicros: 50_000 }, { ownMicros: 30_000, treeMicros: 30_000 }] })).treeUsd).toBeCloseTo(0.08)
  })

  // A turn that died still happened. Without a record the workspace says nothing at all,
  // which is what a spore that was never started looks like.
  it('reads a turn that failed as failed, with why', () => {
    const ws = spore('broke', {
      turns: [{ stopReason: 'error', error: 'MODEL_REFUSED', detail: 'provider said no', concluded: false, rounds: 0, ownMicros: 0 }]
    })
    const state = stateOf(ws)
    expect(state.state).toBe('failed')
    expect(state.last.error).toBe('MODEL_REFUSED')
    expect(state.last.detail).toBe('provider said no')
  })
})

describe('stopping a spore', () => {
  it('says so when nothing is running, and signals nothing', () => {
    expect(stop(spore('quiet', { lock: '' }))).toEqual({ stopped: false, pid: null })
    expect(stop(spore('gone', { lock: JSON.stringify({ pid: 2 ** 22 + 7 }) }))).toEqual({ stopped: false, pid: null })
    expect(readFileSync(resolve(ROOT, 'gone', 'lock'), 'utf8')).toMatch(/pid/)
  })

  it('never signals a live process the lock only names', () => {
    const reused = spore('reused', { lock: JSON.stringify({ pid: process.pid, startedAt: 'then' }) })
    expect(stop(reused)).toEqual({ stopped: false, pid: null })
  })

  it('signals the process that holds the lock', async () => {
    const ws = spore('held')
    const holder = spawn(process.execPath, ['--input-type=module', '-e',
      `import { acquireLock } from '${SPORE_DIR}'; acquireLock(process.argv[1]); process.stdout.write('held\\n'); setInterval(() => {}, 1000)`,
      ws], { stdio: ['ignore', 'pipe', 'inherit'] })
    await once(holder.stdout, 'data')
    const ended = once(holder, 'exit')
    expect(stop(ws)).toEqual({ stopped: true, pid: holder.pid })
    const [, signal] = await ended
    expect(signal).toBe('SIGTERM')
  })
})
