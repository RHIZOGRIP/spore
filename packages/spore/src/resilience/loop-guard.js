/**
 * Loop guard — observes that a tool has stopped making progress.
 *
 * Two signals, and **neither refuses a call.** Both report, and the loop decides;
 * what it decides is the existing soft wrap, which tells the agent to answer with
 * what it has. Taking a tool away was tried, and the agent's answer was to route
 * around the guard by collapsing its remaining work into one call.
 *
 *   1. Consecutive failure — the same tool failing N times with no success between.
 *   2. Identical outcome — the same tool, the same arguments, and the same result,
 *      N times running.
 *
 * The second used to be a hard block on arguments alone, at three. Arguments do not
 * decide what a call observes: a workspace is mutable, cells write into it while the
 * agent watches, and the same `wc -l` twice is how you see one arrive. What says
 * nothing happened is the *result* not changing either — and even then the answer is
 * to wrap, not to refuse, because an agent that gets refused just rephrases.
 */

import { readOutcome } from '../core/call-record.js'
import { textOf } from '../core/message.js'
import { silent } from '../observability/logger.js'

const CONSECUTIVE_FAILURE_LIMIT = 5
const IDENTICAL_OUTCOME_LIMIT = 5

export function createLoopGuard ({ logger = silent } = {}) {
  const pending = new Map() // toolCallId → { name, argsKey }
  const failures = new Map() // name → consecutive failures, reset by any success
  let repeat = null // { name, argsKey, content, count } — the current identical run

  /**
   * What was asked for, kept until the results come back so an outcome can be
   * matched to the arguments that produced it.
   */
  function observe (toolCalls) {
    for (const tc of toolCalls) {
      pending.set(tc.id, { name: tc.name, argsKey: JSON.stringify(tc.arguments || {}) })
    }
  }

  /**
   * Outcomes, after execution. A tool that succeeds once has made progress, so its
   * run of failures starts again from zero; a call that returns something different
   * from the last one ends the identical run for the same reason.
   */
  function record (toolResults) {
    for (const tr of toolResults || []) {
      if (!tr?.toolName) continue
      const content = textOf(tr)
      failures.set(tr.toolName, readOutcome(tr).ok ? 0 : (failures.get(tr.toolName) || 0) + 1)

      const asked = pending.get(tr.toolCallId)
      pending.delete(tr.toolCallId)
      const outcome = { name: tr.toolName, argsKey: asked?.argsKey ?? null, content }
      const same = repeat &&
        repeat.name === outcome.name &&
        repeat.argsKey === outcome.argsKey &&
        repeat.content === outcome.content
      repeat = same ? { ...repeat, count: repeat.count + 1 } : { ...outcome, count: 1 }
    }
  }

  /**
   * The tool that has stopped making progress, if any. The loop decides what that
   * means; today it wraps the turn.
   */
  function stalled () {
    for (const [name, consecutive] of failures) {
      if (consecutive >= CONSECUTIVE_FAILURE_LIMIT) {
        return { tool: name, consecutive, because: `has failed ${consecutive} times in a row without one success` }
      }
    }
    if (repeat && repeat.count >= IDENTICAL_OUTCOME_LIMIT) {
      logger.warn({ tool: repeat.name, count: repeat.count }, '[loop-guard] identical outcome')
      return { tool: repeat.name, consecutive: repeat.count, because: `has returned the same result to the same arguments ${repeat.count} times running` }
    }
    return null
  }

  return { observe, record, stalled }
}
