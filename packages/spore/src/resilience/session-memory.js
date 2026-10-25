/**
 * Session memory — deterministic fact extraction from messages.
 *
 * Extracts key facts from the turn-groups an overflow drops mid-turn, so the
 * notice reporting the drop can say what was lost: recall never reaches the
 * turn being answered, so nothing else carries it.
 *
 * Extraction is turn-group aware: an assistant message + its tool
 * calls/results are compressed into one fact instead of N separate ones,
 * from what the call record says (file paths, exit codes, bytes out)
 * rather than raw content truncation.
 *
 * No LLM calls — purely heuristic. Budget-capped.
 */

import { readOutcome } from '../core/call-record.js'
import { textOf } from '../core/message.js'

const DEFAULT_MAX_FACTS = 100
const DEFAULT_MAX_CHARS = 8000 // ~2000 tokens at 4 chars/token
const COMPACT_MARKER = '[compacted'

function truncate (text, max) {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

// ── What a call did ────────────────────────────────────────────────

/**
 * One projection over the call record. Facts extracted here are handed back to the model
 * as what happened earlier, which makes a wrong one worse than none.
 *
 * The record already carries this. `readOutcome` says whether the call worked, and the
 * fields below are the record's own — so a tool added later summarizes without an
 * entry here, and a tool that changes its record changes this with it.
 */
function summarize (name, args, result) {
  const outcome = readOutcome(result)
  const content = textOf(result)
  const subject = truncate(args?.command || args?.out || args?.path || '', 60)
  const head = subject ? `${name}(${subject})` : `${name}()`

  if (outcome.refused) return `${head} — refused: ${truncate(outcome.error, 60)}`
  if (outcome.exit) return `${head} — exit ${outcome.exit}`

  const record = outcome.record
  if (!outcome.ok && record) return `${head} — ${record.killed ? `killed: ${record.killed}` : record.signal ? `ended by ${record.signal}` : `did not start: ${truncate(record.spawnError, 60)}`}`
  // `read` is the call contract's exception: its record carries the content, and what is
  // worth remembering is how much of the file was seen, not the file.
  if (record?.lines !== undefined) return `${head} — ${record.lines} lines${record.eof === false ? ', more follows' : ''}`
  if (record?.bytesRead !== undefined) return `${head} — ${record.bytesRead} bytes`
  if (record?.replaced !== undefined) return `${head} — replaced`
  if (record?.files?.out?.bytes !== undefined) return `${head} — ${record.files.out.bytes} bytes out`
  if (outcome.exit === 0) return `${head} — exit 0`
  // Not a call record: `ask` returns the question.
  return content && content.length > 50 && !content.startsWith(COMPACT_MARKER)
    ? `${head}: ${truncate(content, 80)}`
    : head
}

// ── Turn-group segmentation ─────────��──────────────────────────────

/**
 * Segment messages into turn-groups.
 *
 * A turn-group is one of:
 *   - user message (standalone)
 *   - assistant (no tools) — standalone reasoning/answer
 *   - assistant (with toolCalls) + consecutive tool_results
 */
function segmentTurnGroups (messages) {
  const groups = []
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      // Collect assistant + its tool_results
      const group = [msg]
      i++
      while (i < messages.length && messages[i].role === 'tool') {
        group.push(messages[i])
        i++
      }
      groups.push(group)
    } else {
      groups.push([msg])
      i++
    }
  }
  return groups
}

// ── Main ───────────────────���───────────────��───────────────────────

/**
 * Create a session memory instance.
 *
 * @param {object} [opts]
 */
export function createSessionMemory ({ logger }) {
  const facts = []

  /**
   * Extract facts from messages (deterministic, no LLM).
   * Call this before messages are dropped.
   *
   * Groups messages into turn-groups and produces one fact per group
   * from what each call's record says.
   */
  function extract (messages) {
    if (!messages?.length) return

    const before = facts.length
    const groups = segmentTurnGroups(messages)

    for (const group of groups) {
      const first = group[0]

      // User message — keep as-is (task context)
      if (first.role === 'user') {
        const text = textOf(first).trim()
        if (text && text.length > 5) {
          facts.push({ text: truncate(text, 200) })
        }
        continue
      }

      // Assistant with tool calls — compress entire turn-group into one fact
      if (first.role === 'assistant' && first.toolCalls?.length) {
        const resultMap = buildResultMap(group)
        const summaries = first.toolCalls.map(tc => summarize(tc.name, tc.arguments, resultMap.get(tc.id)))
        const reasoning = textOf(first).trim()
        let text = summaries.join('; ')
        if (reasoning) text = truncate(reasoning, 100) + ' → ' + text
        facts.push({ text: truncate(text, 300) })
        continue
      }

      // Standalone assistant (no tools) — reasoning/answer
      if (first.role === 'assistant') {
        const text = textOf(first).trim()
        if (text && text.length > 20) {
          facts.push({ text: truncate(text, 300) })
        }
        continue
      }

      // Orphan tool_result (shouldn't happen after segmentation, but be safe)
      if (first.role === 'tool') {
        const content = textOf(first)
        if (content.length > 50 && !content.startsWith(COMPACT_MARKER)) {
          facts.push({ text: `${first.toolName || 'tool'}(): ${truncate(content, 100)}` })
        }
      }
    }

    const trimmed = trimFacts()
    const totalChars = facts.reduce((s, f) => s + f.text.length, 0)
    logger.debug({ extracted: facts.length - before + trimmed, kept: facts.length, chars: totalChars, maxChars: DEFAULT_MAX_CHARS }, '[session-memory] extracted new facts')
  }

  /**
   * Format session memory for the notice an overflow drop leaves.
   * Returns null if empty.
   */
  function format () {
    if (!facts.length) return null
    const lines = facts.map(f => `- ${f.text}`)
    return `[Session context from earlier work]\n${lines.join('\n')}`
  }

  function getFacts () {
    return [...facts]
  }

  function trimFacts () {
    let dropped = 0
    while (facts.length > DEFAULT_MAX_FACTS) { facts.shift(); dropped++ }
    let total = facts.reduce((s, f) => s + f.text.length, 0)
    while (total > DEFAULT_MAX_CHARS && facts.length > 0) {
      total -= facts.shift().text.length
      dropped++
    }
    if (dropped) logger.debug({ dropped }, '[session-memory] budget pressure — dropped oldest facts')
    return -dropped
  }

  return { extract, format, getFacts }
}

/**
 * Build a Map from toolCallId → result message for a turn-group.
 */
function buildResultMap (group) {
  const map = new Map()
  for (let i = 1; i < group.length; i++) {
    const msg = group[i]
    if (msg.role === 'tool' && msg.toolCallId) {
      map.set(msg.toolCallId, msg)
    }
  }
  return map
}
