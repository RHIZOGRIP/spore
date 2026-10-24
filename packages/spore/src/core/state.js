/**
 * What a spore is doing right now, read from what it leaves behind: `lock` for who is
 * running, the workspace's turns for how the last one ended. Nothing here starts anything;
 * `stop` is the one act, and it reaches the runner through the same lock.
 */

import { readLock, readPending, turnSummary } from './spore-dir.js'
import { native } from '../native.js'

export const RUNNING = 'running'

/**
 * Running is the kernel's to say: a turn runs while a process holds the workspace's `flock`
 * (`lockHolder`). The pid written in the file outlives a crash and can be reused, so it never
 * says who is running — only, when nobody holds the lock, that someone held it and did not let
 * go: `releaseLock` truncates rather than unlinks, so a pid left there is a crash. That
 * distinction is the whole reason to look at the lock rather than infer from turns.
 */
export function stateOf (ws) {
  const holder = native.lockHolder(ws)
  const lock = readLock(ws)
  const { lastTurnNo, treeMicros, last } = turnSummary(ws)
  // `treeUsd` is every finished turn's tree, cells included.
  const base = { lastTurnNo, treeUsd: treeMicros / 1e6, last }

  // Draining: the turn has ended and its record waits for the model calls still in flight, which
  // the runner reads to their end before it writes the record and lets go.
  if (holder !== null) {
    const pending = readPending(ws)
    // A runner writes its pid just after it takes the lock, so for that instant the file
    // still names whoever held it before.
    const startedAt = lock?.pid === holder ? lock.startedAt : null
    // A dream holds the lock as a turn does, and says so in it.
    const dreaming = lock?.pid === holder && lock.dream === true
    return { ...base, state: RUNNING, pid: holder, startedAt, ...(dreaming ? { dreaming: true } : {}), ...(pending ? { draining: true, last: pending } : {}) }
  }
  if (lock?.pid) return { ...base, state: 'crashed', pid: lock.pid, startedAt: lock.startedAt }
  return { ...base, state: endedIn(last) }
}

/** Whether a turn runs, from the lock alone — for a spore whose database this runtime may refuse to read. */
export const isRunning = (ws) => native.lockHolder(ws) !== null

/** A state as a person reads it: a spore dreaming is running, and says it is dreaming. */
export const stateWord = (state) => (state.dreaming ? 'dreaming' : state.state)

/** How the last turn left the spore — what it is when nothing runs. */
export function endedIn (last) {
  if (!last) return 'idle'
  if (last.stopReason === 'question') return 'waiting'
  if (last.stopReason === 'cancelled') return 'cancelled'
  if (last.stopReason?.startsWith('hard:')) return 'halted'
  if (last.stopReason?.startsWith('soft:')) return 'wrapped'
  return last.concluded ? 'idle' : 'failed'
}

/**
 * SIGTERM to the process holding the lock, not SIGKILL: the agent aborts the turn on it, which
 * kills each running tool's process group and writes the turn record. SIGKILL would leave
 * the tree running and the turn unrecorded. Sent through a pidfd checked against the lock
 * (`stopHolder`), never to the pid a file names, which may since belong to anything.
 */
export function stop (ws) {
  const pid = native.stopHolder(ws)
  return pid === null ? { stopped: false, pid: null } : { stopped: true, pid }
}
