/**
 * How long a run is given before it says something is wrong rather than slow.
 *
 * A case that never settles — a supervisor killed between taking its lock and writing its
 * turn, a wall limit that does not fire — would otherwise stop the run rather than fail it,
 * and a suite that hangs reports nothing at all. The waiting itself is `runBatch`'s.
 */

import { durationMs } from '../src/delegation/definition.js'

export const SLACK_MS = 60_000

/**
 * When a run has waited long enough to say something is wrong rather than slow.
 *
 * The same shape the fan-out uses: the longest a case is allowed to take, times the
 * number of waves it takes to run them all, plus slack for staging. Sized from what the
 * cases declare rather than from a number chosen here, so raising a case's wall limit
 * raises this with it.
 */
export function runDeadline (cases, { concurrency, limitsOf, now = Date.now(), slackMs = SLACK_MS }) {
  const waves = Math.ceil(cases.length / Math.max(1, concurrency)) || 1
  const longest = Math.max(...cases.map(item => durationMs(limitsOf(item).wall[1]) ?? 0))
  return now + waves * longest + slackMs
}
