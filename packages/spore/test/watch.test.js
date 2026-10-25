import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { watch, watchAll, outcome } from '../src/library/watch.js'
import { appendEvents, appendTurn, databaseOf } from '../src/core/spore-dir.js'

const WS = resolve(tmpdir(), 'spore-watch-test')
const event = () => ({ v: 1, at: 'now', runId: 'r', event: 'round' })

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
})
afterEach(() => rmSync(WS, { recursive: true, force: true }))

const drain = async (options) => {
  const seen = []
  for await (const e of watch(WS, { tick: 10, grace: 60, ...options })) seen.push(e)
  return seen
}

describe('watching a spore as data', () => {
  // A workspace with no lock has never run, so "not running" cannot mean "over" until a
  // runner has been seen — but it must not wait forever either.
  it('yields what is there and ends, when nothing is running', async () => {
    appendEvents(WS, [event(), event()])
    expect((await drain()).map(e => e.seq)).toEqual([1, 2])
  })

  it('resumes from a cursor, so a watcher that reconnects sees no repeats', async () => {
    appendEvents(WS, [event(), event(), event()])
    expect((await drain({ after: 2 })).map(e => e.seq)).toEqual([3])
  })

  it('picks up events written while it is watching', async () => {
    appendEvents(WS, [event()])
    setTimeout(() => appendEvents(WS, [event()]), 20)
    expect((await drain({ grace: 200 })).map(e => e.seq)).toEqual([1, 2])
  })

  it('stops when told to, without waiting for the turn', async () => {
    appendEvents(WS, [event()])
    const stop = new AbortController()
    const seen = []
    for await (const e of watch(WS, { tick: 10, grace: 5000, signal: stop.signal })) {
      seen.push(e)
      stop.abort()
    }
    expect(seen.map(e => e.seq)).toEqual([1])
  })

  it('reports how the last turn ended, for a watcher that wants only that', () => {
    expect(outcome(WS)).toBe(null)
    appendTurn(WS, {
      startedAt: 'S', stopReason: 'soft:cost', concluded: true, rounds: 9, treeMicros: 400_000, workUnits: 20, endedAt: 'T'
    })
    expect(outcome(WS)).toEqual({ stopReason: 'soft:cost', concluded: true, rounds: 9, treeUsd: 0.4, workUnits: 20, endedAt: 'T', deliverables: [], deliverablesMore: 0 })
  })
})

describe('watching many spores', () => {
  it('drops a cursor read from another database, and follows the new one from its start', async () => {
    appendEvents(WS, [event(), event()])
    const stale = { [WS]: { seq: 40, turn: 7, database: 'an earlier database' } }
    const stop = new AbortController()
    const seen = []
    for await (const item of watchAll([WS], { cursors: stale, tick: 10, signal: stop.signal })) {
      seen.push(item.event.seq)
      expect(item.cursor.database).toBe(databaseOf(WS))
      if (seen.length === 2) stop.abort()
    }
    expect(seen).toEqual([1, 2])
  })
})
