/**
 * History compaction — summarize old messages, keep recent tail intact.
 *
 * Pattern: on resume, if history exceeds budget:
 *   1. Split into head (old turns) + tail (last N turn-groups)
 *   2. Send head to LLM for summarization
 *   3. Replace head with one synthetic message
 *   4. Return [summary] + tail
 *
 * The compaction entry is stored in the transcript so next resume
 * doesn't re-summarize already-compacted history.
 */

import { COMPACTED, mark, marked } from '../core/marks.js'
import { textOf } from '../core/message.js'
import { estimateTokens, compactIfNeeded } from './context-guard.js'
import { silent } from '../observability/logger.js'

// Cross-turn retention target for verbatim history. The context window is an
// overflow ceiling, not a retention target: at 1M+ windows a window-fraction
// trigger carries absurd amounts of cold history into every turn. 256K sits at
// the edge of reliable long-context attention and is a proven full usable
// context, so summarizing beyond it sheds dead weight without losing continuity.
// The ratio caps retention to half the window on small-context models so the
// turn's own tool-fetch/output workspace still fits. A definition's `history:` replaces the
// working set, never the ceiling: every round of every turn re-sends what is retained, so a
// spore woken often by small events pays for its whole working set each time.
const WORKING_SET_TOKENS = 256_000
const RETENTION_CEILING_RATIO = 0.50

// Well under the working set, so the summary and the cached prefix behind it hold for many turns.
const KEPT_TOKENS = 24_000

/** The history a turn may carry word for word: the working set, capped at half a known window. */
export const historyBound = (contextLimit, workingSet) => contextLimit
  ? Math.min(workingSet ?? WORKING_SET_TOKENS, Math.floor(contextLimit * RETENTION_CEILING_RATIO))
  : workingSet ?? WORKING_SET_TOKENS

/**
 * Whether a turn carried more history than its bound. One turn may start a little past it — the
 * message that opened it, or the last answer before it, is not summarized until the next — so
 * only past a tenth more is it a bound that did not hold.
 */
export const historyOver = (sent, bound) => sent != null && bound != null && sent > bound + bound / 10

const keptOf = (budget) => Math.min(KEPT_TOKENS, Math.floor(budget / 2))

// However little the budget pays for, the tail is never empty: a single enormous group
// would otherwise leave the turn with a summary and nothing else.
const MIN_TAIL_GROUPS = 2
const COMPACTION_TYPE = '__compaction__'

const SUMMARIZE_PROMPT = `Summarize the following conversation history concisely. Preserve:
- Active tasks and their current status
- Key decisions made and their reasoning
- User instructions that are still relevant
- Important file paths, names, and identifiers
- Any unresolved questions or pending work

Be brief but complete. Use bullet points.`

/**
 * Check if messages need compaction and perform it if so.
 *
 * @param {Array} messages — full message history
 * @param {object} opts
 * @param {object} opts.model — mohdel model proxy (for summarization call)
 * @param {number} opts.contextLimit — model's context token limit
 * @param {number} [opts.budget] — tokens kept word for word, from the definition's `history:`
 * @param {number} [opts.sent] — what the provider counted for the last call on this history, when known
 * @param {Function} [opts.onStarted] — told as the summary is asked for, which can take minutes
 * @param {Function} [opts.onFailed] — told why a history over its budget was not summarized
 * @param {object} [opts.logger]
 * @returns {Array} compacted messages (may be same array if no compaction needed)
 */
export async function compactHistory (messages, { model, contextLimit, budget: workingSet, sent = null, sessionMemory, onStarted, onCompacted, onFailed, onCost, signal, logger = silent } = {}) {
  if (!model) return messages

  const budget = historyBound(contextLimit, workingSet)
  const estimated = estimateTokens(messages)

  if (Math.max(estimated, sent ?? 0) <= budget) return messages

  logger.debug({ estimated, sent, budget }, '[compaction] history over budget — compacting')
  const failed = (why) => {
    logger.warn({ why, estimated, sent, budget }, '[compaction] history over budget and not summarized')
    onFailed?.({ why, estimated, sent, budget })
    return messages
  }

  const tailStart = findTailStart(messages, keptOf(budget))

  if (tailStart <= 1) {
    const compacted = compactIfNeeded(messages, {
      contextLimit,
      budget,
      protectTail: 0,
      logger
    })
    logger.debug({ compacted, estimated: estimateTokens(messages), budget }, '[compaction] tail-only path — stripped tool_results')
    return compacted ? messages : failed('the latest two exchanges are the whole history, and nothing in them could be stripped')
  }

  const head = messages.slice(0, tailStart)
  const tail = messages.slice(tailStart)

  // Check if head is already just a compaction summary
  if (head.length === 1 && marked(head[0], COMPACTED)) return failed('only a summary is before the latest two exchanges')

  // Extract session memory from head before summarization
  if (sessionMemory) sessionMemory.extract(head)

  // Summarize head via LLM
  const headText = formatMessagesForSummary(head)
  logger.debug({ messages: head.length, chars: headText.length }, '[compaction] summarizing')
  onStarted?.({ messages: head.length, kept: tail.length, estimated, sent, budget })

  let summary
  try {
    // Summarizing is a model call like any other: it obeys the deadline, and what it
    // costs is part of what the turn cost. Without the signal a 30ms hard wall waited
    // for it; without the cost it vanished from the record entirely, because the
    // broker client counts it as ours while the loop's own usage never sees it.
    const res = await model.answer([
      { role: 'system', content: [{ type: 'text', text: SUMMARIZE_PROMPT }] },
      { role: 'user', content: headText }
    ], signal ? { signal } : {})
    summary = res.output
    onCost?.(res?.cost || 0)
  } catch (e) {
    if (signal?.aborted) return messages
    return failed(`summarizing failed: ${e.message}`)
  }

  if (!summary) return failed('the summary came back empty')

  logger.debug({ messages: head.length, summaryChars: summary.length }, '[compaction] compacted')

  onCompacted?.(createCompactionEntry(summary, tailStart))

  return [compactionSummaryMessage(summary), ...tail]
}

/**
 * Find the start index of the tail (last N turn-groups).
 * A turn-group starts at a user message or an assistant message with toolCalls.
 */
/**
 * Where the verbatim tail begins: as many recent turn-groups as `budget` pays for.
 *
 * This was a count — `floor(budget / 30_000)`, capped at ten — which spent a token
 * budget through a guess about what a turn-group weighs. A group's weight is not
 * knowable in advance and cannot be: an agentic one carries a tool result, an exchange
 * carries a sentence, and they are two orders of magnitude apart. Worse, a "group" is
 * counted by boundaries, and a history with no tool calls has one at every message, so
 * the guess was wrong twice over. Measured against a 100,000-token budget on a 122K
 * history: three messages kept, 905 tokens, 0.9% of the budget, the other 99%
 * summarized away.
 *
 * So the groups are weighed rather than counted, which needs no constant and holds for
 * either shape.
 */
function findTailStart (messages, budget) {
  let start = messages.length
  let used = 0
  let groups = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    // A group starts at a user message, or at an assistant message that is not itself
    // the result of one — its tool results follow it and belong to it.
    if (!(msg.role === 'user' || (msg.role === 'assistant' && !messages[i - 1]?.toolCalls))) continue
    const cost = estimateTokens(messages.slice(i, start))
    if (groups >= MIN_TAIL_GROUPS && used + cost > budget) break
    used += cost
    start = i
    groups++
  }
  return start
}

/**
 * Format messages into readable text for the summarizer.
 */
export function formatMessagesForSummary (messages) {
  const lines = []
  for (const msg of messages) {
    const text = textOf(msg)
    if (marked(msg, COMPACTED)) {
      lines.push(text)
      continue
    }
    if (msg.role === 'user') {
      lines.push(`User: ${text}`)
    } else if (msg.role === 'assistant') {
      if (msg.toolCalls?.length) {
        const calls = msg.toolCalls.map(tc => `${tc.name}(${JSON.stringify(tc.arguments).slice(0, 100)})`).join(', ')
        lines.push(`Assistant: [called: ${calls}]`)
        if (text) lines.push(`  ${text}`)
      } else {
        lines.push(`Assistant: ${text}`)
      }
    } else if (msg.role === 'tool') {
      const preview = text.slice(0, 200)
      lines.push(`  → ${msg.toolName || 'tool'}: ${preview}`)
    }
  }
  return lines.join('\n')
}

/**
 * The in-transcript form of a persisted compaction entry. Replayed on
 * load so a summarised head is never re-summarised.
 */
export function compactionSummaryMessage (summary) {
  return mark({
    role: 'user',
    content: `[Previous conversation summary]\n\n${summary}`
  }, COMPACTED)
}

/**
 * Create a compaction entry for the transcript. `firstKeptIndex` is
 * an offset into the message array as it stood when compaction ran, so
 * entries replay correctly in sequence.
 */
export function createCompactionEntry (summary, firstKeptIndex) {
  return {
    type: COMPACTION_TYPE,
    summary,
    firstKeptIndex,
    ts: new Date().toISOString()
  }
}

/**
 * Check if a message is a compaction entry.
 */
export function isCompactionEntry (msg) {
  return msg?.type === COMPACTION_TYPE
}
