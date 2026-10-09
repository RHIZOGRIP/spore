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
    return { ...base, state: RUNNING, pid: holder, startedAt, ...(pending ? { draining: true, last: pending } : {}) }
  }
  if (lock?.pid) return { ...base, state: 'crashed', pid: lock.pid, startedAt: lock.startedAt }
  if (!last) return { ...base, state: 'idle' }

  if (last.stopReason === 'question') return { ...base, state: 'waiting' }
  if (last.stopReason === 'cancelled') return { ...base, state: 'cancelled' }
  if (last.stopReason?.startsWith('hard:')) return { ...base, state: 'halted' }
  if (last.stopReason?.startsWith('soft:')) return { ...base, state: 'wrapped' }
  return { ...base, state: last.concluded ? 'idle' : 'failed' }
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
