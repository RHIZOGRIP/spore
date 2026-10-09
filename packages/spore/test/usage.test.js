import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { appendInbox, recordCell, writeTurnRecords } from '../src/core/spore-dir.js'
import { usage } from '../src/core/usage.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '.usage-workspaces')
const A = resolve(ROOT, 'a')
const B = resolve(ROOT, 'b')
const NEVER = resolve(ROOT, 'never-sent')

const DAY_MS = 86_400_000
const dayBefore = (n) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10)
const [D0, D1, D2] = [dayBefore(2), dayBefore(1), dayBefore(0)]
const SPORES = [{ name: 'a', ws: A }, { name: 'b', ws: B }, { name: 'never', ws: NEVER }]

const row = (rows, key) => rows.find(r => r.key === key)

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  for (const ws of [A, B, NEVER]) mkdirSync(ws, { recursive: true })

  appendInbox(A, 'hello')
  appendInbox(A, 'from a chat', { requestId: 'telegram:42' })
  appendInbox(A, 'the daily one', { schedule: { name: 'daily', due: `${D1}T06:00:00.000Z` } })
  writeTurnRecords(A, [
    { startedAt: `${dayBefore(5)}T10:00:00.000Z`, stopReason: 'answer', settled: true, treeMicros: 999, inboxTo: 0 },
    {
      startedAt: `${D0}T10:00:00.000Z`,
      stopReason: 'answer',
      settled: true,
      model: 'anthropic/some-model',
      ownMicros: 100_000,
      treeMicros: 300_000,
      rounds: 4,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 600,
      byPrecursor: { summarize: { micros: 150_000, rounds: 2 } },
      inboxTo: 1
    },
    { startedAt: `${D1}T09:00:00.000Z`, stopReason: 'answer', settled: true, model: 'chatgpt/some-model', treeMicros: 0, rounds: 3, inboxTo: 2 },
    { startedAt: `${D1}T12:00:00.000Z`, stopReason: 'error', settled: true, treeMicros: 50_000, rounds: 1, inboxTo: 3 },
    { startedAt: `${D2}T00:30:00.000Z`, stopReason: 'error', settled: false, inboxTo: 3 }
  ])
  recordCell(A, { precursor: 'route-hook-forge', origin: 'hook:forge', cellWs: '/nowhere', answer: 'later', costUsd: 0.02, durationMs: 10 })

  appendInbox(B, 'hi')
  writeTurnRecords(B, [
    { startedAt: `${D2}T00:10:00.000Z`, stopReason: 'answer', settled: true, model: 'anthropic/some-model', treeMicros: 10_000, rounds: 1, inboxTo: 1 }
  ])
})

afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('usage', () => {
  it('sums settled spend per day over every spore, with the empty days of the window', () => {
    const report = usage({ spores: SPORES, since: dayBefore(3), until: D2, tz: 'UTC' })
    expect(report.window).toEqual({ since: dayBefore(3), until: D2, tz: 'UTC' })
    expect(report.days.map(d => [d.day, d.micros, d.turns, d.cells])).toEqual([
      [dayBefore(3), 0, 0, 0],
      [D0, 300_000, 1, 0],
      [D1, 50_000, 2, 0],
      [D2, 30_000, 1, 1]
    ])
    expect(report.totals).toMatchObject({ micros: 380_000, turns: 4, cells: 1, unmetered: 1, rounds: 9, inputTokens: 1000, cacheReadTokens: 600 })
    expect(report.unsettled).toEqual({ turns: 1 })
  })

  it('splits by spore, origin, model, outcome and precursor, most spent first', () => {
    const { by } = usage({ spores: SPORES, since: D0, until: D2, tz: 'UTC' })
    expect(by.spore.map(r => [r.key, r.micros])).toEqual([['a', 370_000], ['b', 10_000]])

    expect(row(by.origin, 'person')).toMatchObject({ micros: 310_000, turns: 2 })
    expect(row(by.origin, 'telegram')).toMatchObject({ micros: 0, turns: 1 })
    expect(row(by.origin, 'schedule:daily')).toMatchObject({ micros: 50_000, turns: 1 })
    expect(row(by.origin, 'hook:forge')).toMatchObject({ micros: 20_000, cells: 1 })

    expect(row(by.model, 'anthropic/some-model')).toMatchObject({ micros: 310_000, turns: 2, unmetered: 0 })
    expect(row(by.model, 'chatgpt/some-model')).toMatchObject({ micros: 0, turns: 1, unmetered: 1 })
    expect(row(by.model, null)).toMatchObject({ micros: 70_000, turns: 1, cells: 1 })

    expect(row(by.outcome, 'answer')).toMatchObject({ micros: 330_000, turns: 3, cells: 1 })
    expect(row(by.outcome, 'error')).toMatchObject({ micros: 50_000, turns: 1 })

    expect(by.precursor.map(r => [r.key, r.micros])).toEqual([[null, 210_000], ['summarize', 150_000], ['route-hook-forge', 20_000]])
    expect(row(by.precursor, 'summarize')).toMatchObject({ rounds: 2, turns: 1 })
  })

  it('counts a turn on the local day it started', () => {
    const utc = usage({ spores: [{ name: 'b', ws: B }], since: D1, until: D2, tz: 'UTC' })
    const behind = usage({ spores: [{ name: 'b', ws: B }], since: D1, until: D2, tz: 'America/New_York' })
    expect(utc.days.map(d => d.turns)).toEqual([0, 1])
    expect(behind.days.map(d => d.turns)).toEqual([1, 0])
  })

  it('counts a turn whose first entry was already answered as continued', () => {
    appendInbox(B, 'one more')
    writeTurnRecords(B, [
      { startedAt: `${D2}T00:10:00.000Z`, stopReason: 'answer', settled: true, treeMicros: 10_000, inboxTo: 1 },
      { startedAt: `${D2}T00:20:00.000Z`, stopReason: 'answer', settled: true, treeMicros: 5_000, inboxTo: 1 }
    ])
    const { by } = usage({ spores: [{ name: 'b', ws: B }], since: D2, until: D2, tz: 'UTC' })
    expect(by.origin.map(r => [r.key, r.micros])).toEqual([['person', 10_000], ['continued', 5_000]])
  })

  it('refuses a window that is not two ordered dates', () => {
    expect(() => usage({ spores: SPORES, since: D2, until: D0, tz: 'UTC' })).toThrow(expect.objectContaining({ type: 'USAGE_INVALID' }))
    expect(() => usage({ spores: SPORES, since: 'last week', until: D0, tz: 'UTC' })).toThrow(expect.objectContaining({ type: 'USAGE_INVALID' }))
  })
})
