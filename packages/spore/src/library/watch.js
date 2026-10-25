/**
 * Following a spore as data rather than as text.
 *
 * `follow.js` writes the running turn's streams to a terminal, which is what `spore send`
 * and `spore attach` want and what a program cannot use. This yields the event log
 * instead: parsed, resumable on `seq`, and ending when the turn does.
 *
 * Contract: ARCHITECTURE.md, "Watching a spore". A relay serving the same events over a network reads through
 * here too, so the local and remote paths cannot drift.
 */

import { watch as onChange } from 'node:fs'

import { COMMITTED_TO, LOCK_FILE, asked, databaseOf, lastEventSeq, readEvents, readInbox, turnSummary, turnsAfter } from '../core/spore-dir.js'
import { RUNNING, stateOf } from '../core/state.js'

// The longest a follower goes without looking. It wakes as soon as a file it follows changes,
// so this is not how often it reads; it is the bound on a change the kernel's queue dropped.
const TICK_MS = 1000

// A change notice comes when a commit writes its frames to the WAL, which is before the commit
// is visible: SQLite publishes it in the shared-memory index once the WAL is synced, and a
// write to mapped memory raises no notice. So a notice is read at once and again after these,
// the last one past a slow disk's sync; a read that finds nothing new costs a query.
const AFTER_NOTICE_MS = [10, 50, 250]

// How many events a follower reads at a time. One catching up on a long log reads it in
// pieces, each its own short read, rather than all of it in one — nor pins one snapshot of
// the database while it hands them out.
const EVENT_BATCH = 500

/**
 * Wakes a follower when one of `names` changes in a workspace it follows, and after `tick` at
 * the latest. inotify drops events when its queue overflows, and a follower waiting on it
 * alone could wait forever — hence the bound, not a poll standing in for the watch.
 */
function waker (names) {
  const watching = new Map()
  let changed = false
  let wake = null
  let again = []
  const look = () => {
    changed = true
    wake?.()
  }
  const note = (type, name) => {
    if (name && !names.has(String(name))) return
    look()
    for (const timer of again) clearTimeout(timer)
    again = AFTER_NOTICE_MS.map(ms => setTimeout(look, ms))
  }
  return {
    add (ws) {
      if (watching.has(ws)) return
      let watcher = null
      try {
        watcher = onChange(ws, note)
        // A workspace removed while followed stops reporting; the bound still ticks.
        watcher.on('error', () => watcher.close())
      } catch {
        // Not there yet, or gone: nothing to wake on, and the bound covers it.
      }
      watching.set(ws, watcher)
    },
    remove (ws) {
      watching.get(ws)?.close()
      watching.delete(ws)
    },
    wait (tick, signal) {
      if (changed || signal?.aborted) {
        changed = false
        return Promise.resolve()
      }
      return new Promise(resolve => {
        const done = () => {
          clearTimeout(timer)
          wake = null
          changed = false
          signal?.removeEventListener('abort', done)
          resolve()
        }
        const timer = setTimeout(done, tick)
        wake = done
        signal?.addEventListener('abort', done, { once: true })
      })
    },
    close () {
      for (const timer of again) clearTimeout(timer)
      for (const watcher of watching.values()) watcher?.close()
      watching.clear()
    }
  }
}

/**
 * Every event after `after`, then every new one until the turn ends.
 *
 * Liveness is the lock, as everywhere else. The grace window is for the other end of it:
 * a runner spawned a moment ago has not taken the lock yet, and a workspace that never
 * ran has none at all, so "not running" cannot mean "over" until one has been seen.
 *
 * @returns {AsyncGenerator<object>}
 */
export async function * watch (ws, { after = 0, tick = TICK_MS, grace = 5000, signal } = {}) {
  let from = after
  const next = () => {
    const events = readEvents(ws, { after: from, limit: EVENT_BATCH })
    if (events.length) from = events.at(-1).seq
    return events
  }
  const drain = function * () {
    for (;;) {
      const events = next()
      yield * events
      if (events.length < EVENT_BATCH) return
    }
  }
  let started = false
  const deadline = Date.now() + grace
  const changes = waker(new Set([...COMMITTED_TO, LOCK_FILE]))
  changes.add(ws)

  try {
    for (;;) {
      yield * drain()
      if (signal?.aborted) return

      const running = stateOf(ws).state === RUNNING
      if (running) started = true
      else if (started || Date.now() > deadline) break

      // Before the turn is seen running, no longer than the grace has left.
      await changes.wait(started ? tick : Math.max(1, Math.min(tick, deadline - Date.now())), signal)
    }

    // One last pass: the turn's final events land between the check and the loop exiting.
    yield * drain()
  } finally {
    changes.close()
  }
}

/**
 * Every turn finished after `turn`: its record, which carries its answer as `output`, and the
 * inbox entries it answered — those with `inboxNo` in `(inboxFrom, inboxTo]`. A sender that
 * kept the `inbox` `send` returned finds its message among them; an entry carrying `schedule`
 * was said by the clock.
 *
 * @returns {{ turn: number, ended: { record: object, asked: object[] }[] }}
 */
export function turnsSince (ws, turn) {
  const turns = turnsAfter(ws, turn)
  if (!turns.length) return { turn, ended: [] }
  const ended = turns.map(record => ({
    record,
    asked: asked(record, readInbox(ws, { after: record.inboxFrom, upto: record.inboxTo }))
  }))
  return { turn: turns.at(-1).turnNo, ended }
}

/**
 * Many spores followed at once, for as long as the caller wants: what a service in front of
 * them — a chat bot, an application serving many users — reads instead of one `watch` per
 * turn it happened to start.
 *
 * Yields `{ ws, event, cursor }` for every event past a spore's cursor, and
 * `{ ws, turn: { record, asked }, cursor }` for every turn it records. `cursor` is
 * where that spore stands after the item — `{ seq, turn, database }`, the last event and the
 * last turn handled in that database — and is what a caller saves to carry on after a restart;
 * `cursors` hands them back. A spore with no cursor starts where it is now: what ended before
 * anyone looked is not news. A cursor read from another database — the spore was made again —
 * is dropped, and the new database is followed from its start, since all of it is new.
 *
 * `spores` is a list, or a function answering the current one, read again on every wake so a
 * spore added or dropped is picked up without starting over.
 *
 * @returns {AsyncGenerator<{ ws: string, cursor: { seq: number, turn: number, database: string|null }, event?: object, turn?: object }>}
 */
export async function * watchAll (spores, { cursors = {}, tick = TICK_MS, signal } = {}) {
  const current = () => (typeof spores === 'function' ? spores() : spores)
  const at = new Map()
  const changes = waker(new Set(COMMITTED_TO))
  try {
    for (;;) {
      const now = new Set(current())
      for (const ws of now) {
        if (at.has(ws)) continue
        const saved = cursors[ws]
        const database = databaseOf(ws)
        at.set(ws, saved && saved.database === database
          ? { seq: saved.seq, turn: saved.turn, database }
          : saved ? { seq: 0, turn: 0, database } : { seq: lastEventSeq(ws), turn: turnSummary(ws).lastTurnNo, database })
        changes.add(ws)
      }
      for (const ws of [...at.keys()]) {
        if (now.has(ws)) continue
        at.delete(ws)
        changes.remove(ws)
      }

      for (const [ws, cursor] of at) {
        const database = databaseOf(ws)
        if (database !== cursor.database) Object.assign(cursor, { seq: 0, turn: 0, database })
        for (;;) {
          const events = readEvents(ws, { after: cursor.seq, limit: EVENT_BATCH })
          for (const event of events) {
            cursor.seq = event.seq
            yield { ws, event, cursor: { ...cursor } }
          }
          if (events.length < EVENT_BATCH) break
        }
        const { ended } = turnsSince(ws, cursor.turn)
        for (const turn of ended) {
          cursor.turn = turn.record.turnNo
          yield { ws, turn, cursor: { ...cursor } }
        }
      }

      if (signal?.aborted) return
      await changes.wait(tick, signal)
      if (signal?.aborted) return
    }
  } finally {
    changes.close()
  }
}

/** How the last turn ended, for a watcher that wants the outcome and not the events. */
export function outcome (ws) {
  const { last } = turnSummary(ws)
  if (!last) return null
  return {
    stopReason: last.stopReason,
    concluded: last.concluded,
    rounds: last.rounds ?? 0,
    treeUsd: last.treeUsd,
    workUnits: last.workUnits ?? 0,
    deliverables: last.deliverables ?? [],
    deliverablesMore: last.deliverablesMore ?? 0,
    endedAt: last.endedAt
  }
}
