/**
 * Loop guard — observes that a tool has stopped making progress.
 *
 * Two signals, and **neither refuses a call.** Both report, and the loop decides;
 * what it decides is the existing soft wrap, which tells the agent to answer with
 * what it has. Taking a tool away was tried, and the agent's answer was to route
 * around the guard by collapsing its remaining work into one call.
 *
 *   1. Consecutive failure — N rounds running in which every call of a tool failed.
 *   2. Identical outcome — the same tool, the same arguments, and the same result,
 *      N rounds running.
 *
 * Both count rounds, not results. A round is one decision: the model sends its calls before it
 * has read any of their results, so five calls sharing one mistake are one failure, and a
 * failure says the agent is stuck only once it has read the last one and failed again.
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

const sameOutcome = (a, b) => a.name === b.name && a.argsKey === b.argsKey && a.content === b.content

export function createLoopGuard ({ logger = silent } = {}) {
  const pending = new Map() // toolCallId → { name, argsKey }
  const failures = new Map() // name → rounds running in which every call of it failed
  let repeat = null // { name, argsKey, content, count } — the current identical run, in rounds

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
   * One round's outcomes, after execution. A tool one of whose calls succeeded has made
   * progress, so its run of failed rounds starts again from zero; a round that returns anything
   * other than the last round's one outcome ends the identical run for the same reason.
   */
  function record (toolResults) {
    const worked = new Map()
    const outcomes = []
    for (const tr of toolResults || []) {
      if (!tr?.toolName) continue
      worked.set(tr.toolName, worked.get(tr.toolName) === true || readOutcome(tr).ok)

      const asked = pending.get(tr.toolCallId)
      pending.delete(tr.toolCallId)
      outcomes.push({ name: tr.toolName, argsKey: asked?.argsKey ?? null, content: textOf(tr) })
    }
    for (const [name, ok] of worked) failures.set(name, ok ? 0 : (failures.get(name) || 0) + 1)
    if (!outcomes.length) return

    const [outcome] = outcomes
    const one = outcomes.every(other => sameOutcome(other, outcome))
    if (!one) repeat = null
    else repeat = repeat && sameOutcome(repeat, outcome) ? { ...repeat, count: repeat.count + 1 } : { ...outcome, count: 1 }
  }

  /**
   * The tool that has stopped making progress, if any. The loop decides what that
   * means; today it wraps the turn.
   */
  function stalled () {
    for (const [name, consecutive] of failures) {
      if (consecutive >= CONSECUTIVE_FAILURE_LIMIT) {
        return { tool: name, consecutive, because: `has failed in ${consecutive} rounds in a row without one success` }
      }
    }
    if (repeat && repeat.count >= IDENTICAL_OUTCOME_LIMIT) {
      logger.warn({ tool: repeat.name, count: repeat.count }, '[loop-guard] identical outcome')
      return { tool: repeat.name, consecutive: repeat.count, because: `has returned the same result to the same arguments ${repeat.count} rounds running` }
    }
    return null
  }

  return { observe, record, stalled }
}
