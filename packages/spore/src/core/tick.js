/**
 * The pass that fires schedules and lets held deliveries go: every workspace `spore ls` finds,
 * every schedule in it, a `send` for each one that is due, a `release` of what its routers
 * held, a word for each job whose supervisor died, and a dream for a spore that is due one.
 * Contract: ARCHITECTURE.md, "Turns the clock starts", "Deliveries nobody typed", "Jobs" and
 * "Dreams".
 *
 * It keeps nothing between passes. What fired last is on the inbox, when a schedule changed
 * is its file's, and what a spore is doing is `stateOf` — so a pass that dies loses nothing,
 * and passes run by a timer, by hand and by a daemon fire each slot once, because they take
 * one lock. It never waits on a turn: `send` starts the runner detached, so the lock is held
 * for as long as reading the directories takes.
 */

import { closeSync, existsSync } from 'node:fs'

import { list } from '../library/verbs.js'
import { native } from '../native.js'
import { survey, scheduleDir } from './schedule.js'
import { paused } from './admission.js'
import { dreamDue } from './dream.js'
import { reportInterrupted } from './job.js'
import { heldIn } from './spore-dir.js'
import { release, send, startDream } from './send.js'
import { stateOf } from './state.js'
import { parsedDefinition } from '../delegation/definition.js'
import { errorText } from '../observability/errors.js'

export const TICK_LOCK = native.tickLockPath()

/**
 * One pass. `ran: false` when another pass holds the lock, which is not a failure: that pass
 * is firing the same slots.
 *
 * Each line is one schedule: `fired`, `held` with why, `refused` with why, `stale`, `later`,
 * `spent`, or `failed` when `send` refused for a reason other than every slot taken — or one
 * spore's held deliveries: `released`, with how many and whether a turn started — or one job whose
 * supervisor is gone: `interrupted`, said to its spore — or one spore's dream: `dreaming` once
 * started, `held` with why while every slot is taken or the spend limit reached.
 *
 * While spores are paused, a pass fires and releases nothing: `paused` carries the mark, and what was due
 * goes at the first pass after `spore unpause` — one catch-up slot per schedule, never a burst.
 *
 * @returns {{ ran: boolean, paused?: object, lines: object[] }}
 */
export function tick ({ now = Date.now(), configFile, lock = TICK_LOCK, env = process.env } = {}) {
  const fd = native.hold(lock)
  if (fd === null) return { ran: false, lines: [] }
  try {
    const pause = paused()
    if (pause) return { ran: true, paused: pause, lines: [] }
    const lines = list({ configFile }).workspaces.flatMap(spore => [...interruptedIn(spore, { env, configFile }), ...releaseIn(spore, { now, env, configFile }), ...fireIn(spore, { now, env, configFile }), ...dreamIn(spore, { now, env, configFile })])
    return { ran: true, lines }
  } finally {
    closeSync(fd)
  }
}

function interruptedIn ({ ws }, { env, configFile }) {
  try {
    return reportInterrupted(ws, { env, configFile, log: () => {} }).map(job => ({ ws, state: 'interrupted', job: job.name, run: job.run }))
  } catch (err) {
    return [{ ws, state: 'failed', why: errorText(err) }]
  }
}

const HELD_BY = {
  ADMISSION_FULL: 'every turn slot is taken',
  SPEND_LIMIT: 'the spend limit is reached'
}

function releaseIn ({ ws }, { now, env, configFile }) {
  if (!heldIn(ws).length) return []
  try {
    const { released, started } = release(ws, { now, env, configFile })
    return released.length ? [{ ws, state: 'released', deliveries: released.length, started }] : []
  } catch (err) {
    if (HELD_BY[err.type]) return [{ ws, state: 'held', why: HELD_BY[err.type] }]
    return [{ ws, state: 'failed', why: errorText(err) }]
  }
}

function fireIn (spore, { now, env, configFile }) {
  const { ws } = spore
  if (!existsSync(scheduleDir(ws))) return []
  const definition = parsedDefinition(ws)
  if (definition.error) return [{ ws, state: 'refused', why: `spore.cmk ${definition.error}` }]

  // One turn at a time: once a schedule has started one, the rest of this spore's due
  // schedules would land in it as interjections, so they wait for the next pass.
  let started = false
  return survey(ws, { spore, grant: definition.schedules ?? null, now }).map(({ message, ...row }) => {
    const line = { ws, ...row }
    if (row.state !== 'due') return line
    if (started) return { ...line, state: 'held', why: 'running' }
    try {
      send(ws, message, { schedule: { name: row.name, due: row.slot }, env, configFile })
      started = true
      return { ...line, state: 'fired' }
    } catch (err) {
      if (HELD_BY[err.type]) return { ...line, state: 'held', why: HELD_BY[err.type] }
      return { ...line, state: 'failed', why: errorText(err) }
    }
  })
}

// After the schedules and the releases, so a turn either started takes the spore first: the state
// is read again, and a running spore is due no dream.
function dreamIn ({ ws }, { now, env, configFile }) {
  const definition = parsedDefinition(ws)
  if (definition.error || !definition.dream) return []
  if (!dreamDue(ws, { dream: definition.dream, spore: stateOf(ws), now }).due) return []
  try {
    const { started } = startDream(ws, { env, configFile })
    return started ? [{ ws, state: 'dreaming' }] : []
  } catch (err) {
    if (HELD_BY[err.type]) return [{ ws, state: 'held', why: HELD_BY[err.type] }]
    return [{ ws, state: 'failed', why: errorText(err) }]
  }
}

/**
 * A pass as the journal reads it: one JSON line while spores are paused, or one per firing that
 * did something, and the exit code — 1 when one failed.
 */
export function tickReport (result) {
  if (result.paused) return { lines: [JSON.stringify({ state: 'paused', ...result.paused })], exit: 0 }
  const shown = result.lines.filter(line => line.state !== 'later' && line.state !== 'spent')
  return { lines: shown.map(line => JSON.stringify(line)), exit: result.lines.some(line => line.state === 'failed') ? 1 : 0 }
}
