import { describe, it, expect, beforeEach, afterAll, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { changedBetween, dreamDue, runDream } from '../src/core/dream.js'
import { definitionWith } from '../src/core/identity-defaults.js'
import { dreamRecords, enqueue, holdDelivery, readTranscriptEntries, readTurns, recordCell, writeTranscriptEntries, writeTurnRecords } from '../src/core/spore-dir.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '.dream-workspace')

const HOUR = 3_600_000
const NOW = Date.parse('2026-10-12T12:00:00.000Z')
const DREAM = { turns: 50, quiet: HOUR, wall: { soft: 10 * 60_000, hard: 15 * 60_000 } }
const IDLE = { state: 'idle' }

const records = (over = {}) => ({ afterTurn: 0, dreamBytes: null, turnsSince: 50, endedAt: new Date(NOW - HOUR).toISOString(), dataBytes: null, unread: false, heldDue: null, ...over })
const after = (turnsSince, quietMs, over = {}) => dreamDue('/unused', { dream: DREAM, spore: IDLE, now: NOW, records: records({ turnsSince, endedAt: new Date(NOW - quietMs).toISOString(), ...over }) })

describe('dreamDue', () => {
  it('weighs pressure against quiet: the more turns, the less quiet a dream needs', () => {
    expect(after(50, HOUR).due).toBe(true)
    expect(after(50, HOUR - 60_000).due).toBe(false)
    expect(after(100, HOUR / 2).due).toBe(true)
    expect(after(100, HOUR / 2 - 60_000).due).toBe(false)
    expect(after(13, 4 * HOUR).due).toBe(true)
    expect(after(13, 3.5 * HOUR).due).toBe(false)
  })

  it('counts a data/ that grew as more turns', () => {
    expect(after(25, HOUR).due).toBe(false)
    expect(after(25, HOUR, { dreamBytes: 1000, dataBytes: 2000 }).due).toBe(true)
    expect(after(50, HOUR, { dreamBytes: 2000, dataBytes: 1000 }).due).toBe(true)
  })

  it('never dreams on too little, nor right after a turn, however much there is', () => {
    const little = after(12, 100 * HOUR)
    expect(little).toMatchObject({ due: false, why: 'too little since the last dream', quietLeft: null })
    expect(after(1000, HOUR / 4 - 60_000)).toMatchObject({ due: false, why: 'not quiet long enough' })
    expect(after(1000, HOUR / 4).due).toBe(true)
  })

  it('says how much quiet is left at today\'s pressure', () => {
    expect(after(100, 10 * 60_000).quietLeft).toBe(20 * 60_000)
  })

  it('waits for a spore in the middle of something, for what is said, and for a release the dream would hold up', () => {
    const due = { dream: DREAM, now: NOW, records: records() }
    expect(dreamDue('/unused', { ...due, spore: { state: 'running' } })).toMatchObject({ due: false, why: 'running' })
    expect(dreamDue('/unused', { ...due, spore: { state: 'waiting' } })).toMatchObject({ due: false, why: 'waiting' })
    expect(dreamDue('/unused', { ...due, spore: { state: 'idle', draining: true } })).toMatchObject({ due: false, why: 'draining' })
    expect(dreamDue('/unused', { ...due, spore: IDLE, records: records({ unread: true }) }).due).toBe(false)
    expect(dreamDue('/unused', { ...due, spore: IDLE, records: records({ heldDue: new Date(NOW + 10 * 60_000).toISOString() }) }).due).toBe(false)
    expect(dreamDue('/unused', { ...due, spore: IDLE, records: records({ heldDue: new Date(NOW + HOUR).toISOString() }) }).due).toBe(true)
    for (const state of ['wrapped', 'halted', 'cancelled']) expect(dreamDue('/unused', { ...due, spore: { state } }).due).toBe(true)
  })
})

describe('dreamRecords', () => {
  const ws = resolve(ROOT, 'ws')
  const turn = (endedAt, dataBytes) => ({ startedAt: endedAt, endedAt, stopReason: 'answer', concluded: true, dataBytes })

  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(ws, { recursive: true })
  })
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  it('reads a spore that never dreamt from its turns', () => {
    writeTurnRecords(ws, [turn('2026-10-12T09:00:00.000Z', 100), turn('2026-10-12T10:00:00.000Z', 300)])
    expect(dreamRecords(ws)).toEqual({ afterTurn: 0, dreamBytes: null, turnsSince: 2, endedAt: '2026-10-12T10:00:00.000Z', dataBytes: 300, unread: false, heldDue: null })
  })

  it('counts from the last dream, and reads what waits', () => {
    writeTurnRecords(ws, [turn('2026-10-12T08:00:00.000Z', 100), turn('2026-10-12T09:00:00.000Z', 200), turn('2026-10-12T10:00:00.000Z', 400)])
    recordCell(ws, { precursor: 'tidy', origin: 'dream', cellWs: '/cells/dream/1', answer: 'tidied', costUsd: 0.1, durationMs: 1000, afterTurn: 1, dataBytes: 100 })
    holdDelivery(ws, 'later', { hook: { name: 'forge', event: 'push', delivery: 'd-1' }, releaseAt: '2026-10-12T13:00:00.000Z', deadline: '2026-10-12T14:00:00.000Z' })
    enqueue(ws, 'hello')
    expect(dreamRecords(ws)).toMatchObject({ afterTurn: 1, dreamBytes: 100, turnsSince: 2, dataBytes: 400, unread: true, heldDue: '2026-10-12T13:00:00.000Z' })
  })
})

describe('changedBetween', () => {
  const files = (entries) => new Map(entries.map(([path, bytes]) => [path, { bytes, mtimeMs: 0 }]))

  it('says a directory gone whole in one line, and what is left of one in part file by file', () => {
    const before = files([['data/pipx/a/x.py', 10], ['data/pipx/b.py', 5], ['data/notes/keep.md', 1], ['data/notes/old.md', 2], ['data/run.err', 0]])
    const after = files([['data/notes/keep.md', 1], ['data/memory/azure.md', 7]])
    expect(changedBetween(before, after)).toEqual({
      removed: [{ path: 'data/pipx', files: 2, bytes: 15 }, { path: 'data/notes/old.md', files: 1, bytes: 2 }, { path: 'data/run.err', files: 1, bytes: 0 }],
      added: [{ path: 'data/memory', files: 1, bytes: 7 }]
    })
  })
})

describe('runDream', () => {
  const DREAM = 'dream: [50, 1h]\ndream.cost: [0.50, 1.00]\ndream.wall: [60s, 90s]\ndream.precursor: tidy\n'
  const TIDY = '---\nname: tidy\ntools: [read, write, wsexec]\nrounds: [20, 30]\ncost: [0.20, 0.40]\nwall: [1m, 2m]\non-wrap: keep\n---\n\nYou tidy the spore you dream for.\n'
  let dir
  let ws
  let env

  const put = (rel, body = 'x') => {
    mkdirSync(dirname(join(ws, rel)), { recursive: true })
    writeFileSync(join(ws, rel), body)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spore-dream-'))
    ws = join(dir, 'main')
    mkdirSync(join(ws, 'precursors'), { recursive: true })
    writeFileSync(join(ws, 'spore.cmk'), definitionWith('fake/root').replace('model: fake/root\n', `model: fake/root\n${DREAM}`))
    writeFileSync(join(ws, 'precursors', 'tidy.cmk'), TIDY)
    env = { XDG_STATE_HOME: join(dir, 'state') }
    writeTurnRecords(ws, [{ startedAt: '2026-10-12T09:00:00.000Z', endedAt: '2026-10-12T09:01:00.000Z', stopReason: 'answer', concluded: true, dataBytes: 20 }])
    writeTranscriptEntries(ws, [{ at: '2026-10-12T09:00:00.000Z', kind: 'message', role: 'user', turnId: readTurns(ws)[0].turnId, message: { role: 'user', content: 'install azure-cli for the test' } }])
    put('data/pipx/venv/az.py', '0123456789')
    put('data/pip-cache/blob', '01234')
    put('data/run.err', '')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('runs the named precursor as a super cell, hands it what was said and what is kept, and records what it changed', async () => {
    let asked
    const ran = await runDream(ws, {
      env,
      launch: async (question) => {
        asked = { ...question, transcript: readFileSync(join(question.cellWs, 'transcript.md'), 'utf8'), facts: JSON.parse(readFileSync(join(question.cellWs, 'facts.json'), 'utf8')) }
        rmSync(join(ws, 'data', 'pipx'), { recursive: true })
        rmSync(join(ws, 'data', 'pip-cache'), { recursive: true })
        rmSync(join(ws, 'data', 'run.err'))
        put('data/memory/azure.md', 'azure-cli was installed for a test, then removed')
        return { answer: 'Removed the Azure CLI test installs.', costUsd: 0.12, durationMs: 40_000, failed: null }
      }
    })

    expect(asked).toMatchObject({ precursor: 'tidy', dream: true, wallMs: 90_000 })
    expect(asked.cellWs.startsWith(join(dir, 'state', 'spore', 'cells', 'main', 'dream'))).toBe(true)
    expect(asked.transcript).toContain('install azure-cli for the test')
    expect(asked.facts.directories.find(fact => fact.path === 'data/pipx')).toMatchObject({ files: 1, bytes: 10 })
    expect(asked.facts.empty).toEqual({ files: 1, paths: ['data/run.err'] })

    expect(ran.changed).toEqual({
      removed: [{ path: 'data/pipx', files: 1, bytes: 10 }, { path: 'data/pip-cache', files: 1, bytes: 5 }, { path: 'data/run.err', files: 1, bytes: 0 }],
      added: [{ path: 'data/memory', files: 1, bytes: 48 }]
    })
    expect(dreamRecords(ws)).toMatchObject({ afterTurn: 1, dreamBytes: 48, turnsSince: 0 })

    const note = readTranscriptEntries(ws).at(-1)
    expect(note.marks).toEqual(['dreamt'])
    expect(note.message.content).toContain('Removed the Azure CLI test installs.')
    expect(note.message.content).toContain('- data/pipx, 10 bytes')
  })

  it('refuses a dream whose precursor is not there, and starts nothing', async () => {
    rmSync(join(ws, 'precursors', 'tidy.cmk'))
    const ran = await runDream(ws, { env, launch: async () => { throw new Error('started') } })
    expect(ran).toMatchObject({ started: false, failed: expect.stringContaining('precursors/tidy.cmk is not there') })
    expect(existsSync(join(dir, 'state'))).toBe(false)
  })

  it('leaves the conversation alone when a dream said and changed nothing', async () => {
    const entries = readTranscriptEntries(ws).length
    await runDream(ws, { env, launch: async () => ({ answer: null, costUsd: 0.01, durationMs: 1000, failed: 'exited 1 — past its wall' }) })
    expect(readTranscriptEntries(ws)).toHaveLength(entries)
  })
})
