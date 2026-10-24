import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { appendEvents, appendTurn, databaseOf, enqueue, readEvents, readInbox, statePath } from '../src/core/spore-dir.js'
import { turnsSince, watchAll } from '../src/library/watch.js'

let root

const spore = (name) => {
  const ws = resolve(root, name)
  mkdirSync(ws)
  return ws
}

const event = (ws, seq, fields) => appendEvents(ws, [{ v: 1, seq, at: 't', runId: 'r1', ...fields }])
const turn = (ws, record) => appendTurn(ws, { startedAt: 't', ...record })

// Takes items off a follower until `count` have come or `ms` have passed. A `next()` still
// waiting when time runs out is kept for the following take, or its item would be lost.
const reader = (follower) => {
  let pending = null
  return async (count, ms = 3000) => {
    const items = []
    const deadline = Date.now() + ms
    while (items.length < count) {
      const left = deadline - Date.now()
      if (left <= 0) break
      pending ??= follower.next()
      const got = await Promise.race([pending, new Promise(resolve => setTimeout(resolve, left, 'timeout'))])
      if (got === 'timeout') break
      pending = null
      if (got.done) break
      items.push(got.value)
    }
    return items
  }
}

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'spore-watch-all-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('reading the event log from where a follower stopped', () => {
  it('carries on from its position, and reads only what is new', () => {
    const ws = spore('a')
    event(ws, 1, { event: 'round', index: 0 })
    const first = readEvents(ws, { after: 0 })
    expect(first.map(e => e.seq)).toEqual([1])
    event(ws, 2, { event: 'round', index: 1 })
    expect(readEvents(ws, { after: first.at(-1).seq }).map(e => e.seq)).toEqual([2])
  })
})

describe('the turns a spore recorded since a cursor', () => {
  it('carries each one\'s answer and the messages it answered, with no event to read it from', () => {
    const ws = spore('a')
    const asked = enqueue(ws, 'summarise the tickets').inbox
    const clock = enqueue(ws, 'Check the queue.', { schedule: { name: 'queue', due: '2026-09-28T07:00:00Z' } }).inbox
    turn(ws, { runId: 'r1', stopReason: 'answer', concluded: true, output: 'three tickets, one about billing', inboxTo: clock })

    expect(readInbox(ws).map(e => e.inboxNo)).toEqual([asked, clock])
    const { turn: last, ended } = turnsSince(ws, 0)
    expect(last).toBe(1)
    expect(ended[0].record.output).toBe('three tickets, one about billing')
    expect(ended[0].asked.map(e => e.inboxNo)).toEqual([asked, clock])
    expect(ended[0].asked[1].schedule).toBe('queue')
  })
})

describe('following many spores', () => {
  it('starts where each spore is, and yields what happens after', async () => {
    const a = spore('a')
    const b = spore('b')
    event(a, 1, { event: 'round', index: 0 })
    const stop = new AbortController()
    const take = reader(watchAll([a, b], { signal: stop.signal, tick: 200 }))

    expect(await take(1, 300)).toEqual([])

    event(b, 1, { event: 'stream', kind: 'message', delta: 'hel' })
    const said = enqueue(b, 'hello').inbox
    event(b, 2, { event: 'complete', output: 'hi' })
    turn(b, { runId: 'r1', stopReason: 'answer', concluded: true, output: 'hi', inboxTo: said })

    const items = await take(4)
    stop.abort()
    expect(items.map(i => [i.ws, i.event?.event ?? 'turn'])).toEqual([[b, 'stream'], [b, 'complete'], [b, 'turn_end'], [b, 'turn']])
    expect(items[2].event).toMatchObject({ seq: 3, runId: 'r1', turnNo: 1, stopReason: 'answer', concluded: true, inboxTo: said })
    expect(items[3].turn.record.output).toBe('hi')
    expect(items[3].turn.asked.map(e => e.inboxNo)).toEqual([said])
    expect(items[3].cursor).toEqual({ seq: 3, turn: 1, database: databaseOf(b) })
  })

  it('carries on from saved cursors without repeating anything', async () => {
    const a = spore('a')
    event(a, 1, { event: 'round', index: 0 })
    event(a, 2, { event: 'round', index: 1 })
    const stop = new AbortController()
    const take = reader(watchAll([a], { cursors: { [a]: { seq: 1, turn: 0, database: databaseOf(a) } }, signal: stop.signal, tick: 200 }))
    const items = await take(2, 600)
    stop.abort()
    expect(items.map(i => i.event.seq)).toEqual([2])
  })

  it('picks up a spore added while it follows', async () => {
    const a = spore('a')
    const followed = [a]
    const stop = new AbortController()
    const take = reader(watchAll(() => followed, { signal: stop.signal, tick: 100 }))
    const first = take(1, 2000)
    const b = spore('b')
    followed.push(b)
    await new Promise(resolve => setTimeout(resolve, 250))
    event(b, 1, { event: 'round', index: 0 })
    const items = await first
    stop.abort()
    expect(items.map(i => i.ws)).toEqual([b])
  })

  it('wakes on a change rather than waiting out its bound', async () => {
    const a = spore('a')
    const stop = new AbortController()
    const take = reader(watchAll([a], { signal: stop.signal, tick: 10_000 }))
    const pending = take(1, 5000)
    await new Promise(resolve => setTimeout(resolve, 100))
    const at = Date.now()
    event(a, 1, { event: 'round', index: 0 })
    const items = await pending
    stop.abort()
    expect(items).toHaveLength(1)
    expect(Date.now() - at).toBeLessThan(2000)
  })

  it('does not wake itself on a database left in WAL mode with no writer', async () => {
    const a = spore('a')
    enqueue(a, 'hello')
    const writer = new DatabaseSync(statePath(a))
    writer.exec('PRAGMA journal_mode = WAL; UPDATE t_workspace SET lastSeq = lastSeq')
    const other = new DatabaseSync(statePath(a), { readOnly: true })
    other.prepare('SELECT count(*) FROM t_inbox').get()
    writer.close()
    other.close()
    expect(existsSync(`${statePath(a)}-wal`)).toBe(true)

    let wakes = 0
    const stop = new AbortController()
    const follower = watchAll(() => { wakes += 1; return [a] }, { signal: stop.signal, tick: 500 })
    const ended = follower.next()
    await new Promise(resolve => setTimeout(resolve, 1500))
    stop.abort()
    await ended
    expect(wakes).toBeLessThan(10)
  })
})
