/**
 * Session memory — deterministic fact extraction from messages.
 *
 * Extracts key facts before messages are compacted or dropped,
 * so the model retains continuity across context window management.
 * Injected into system prompt as plain-text bullet points.
 *
 * Extraction is turn-group aware: an assistant message + its tool
 * calls/results are compressed into one fact instead of N separate ones.
 * Tool-specific extractors pull the semantically useful bits from args
 * and results (file paths, exit codes, match counts) instead of raw
 * content truncation.
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
 * One projection over the call record, replacing ten per-tool extractors that were
 * written against v2's shapes and had silently stopped being true: the `exec` one
 * looked for a textual `exit N` and so reported `exit 0` for every failure, and the
 * `write` one read `args.path` where v3 names the target `out`, so every write was
 * `wrote ?`. Facts extracted here are handed back to the model as what happened
 * earlier, which makes a wrong one worse than none.
 *
 * The record already carries this. `readOutcome` says whether the call worked, and the
 * fields below are the record's own — so a tool added later summarizes without an
 * entry here, and a tool that changes its record changes this with it.
 */
function summarize (name, args, result) {
  const outcome = readOutcome(result)
  const content = textOf(result)
  const subject = truncate(args?.command || args?.query || args?.out || args?.path || '', 60)
  const head = subject ? `${name}(${subject})` : `${name}()`

  if (outcome.refused) return `${head} — refused: ${truncate(outcome.error, 60)}`
  if (outcome.exit) return `${head} — exit ${outcome.exit}`

  const record = outcome.record
  // `read` is the call contract's exception: its result is the content, and what is
  // worth remembering is how much of the file was seen, not the file.
  if (record?.lines !== undefined) return `${head} — ${record.lines} lines${record.eof === false ? ', more follows' : ''}`
  if (record?.bytesRead !== undefined) return `${head} — ${record.bytesRead} bytes`
  if (record?.replaced !== undefined) return `${head} — replaced`
  if (record?.files?.out?.bytes !== undefined) return `${head} — ${record.files.out.bytes} bytes out`
  if (outcome.exit === 0) return `${head} — exit 0`
  // Not a call record: `ask` returns the question, and a precursor's own tool returns
  // whatever it returns.
  return content && content.length > 50 && !content.startsWith(COMPACT_MARKER)
    ? `${head}: ${truncate(content, 80)}`
    : head
}

/**
 * Summarize one call. A precursor may supply its own extractor for a tool it granted;
 * everything else goes through the projection above.
 */
function summarizeToolCall (tc, result, customExtractors) {
  const extractor = customExtractors?.[tc.name]
  if (extractor) {
    try {
      return extractor(tc.arguments, textOf(result))
    } catch {}
  }
  return summarize(tc.name, tc.arguments, result)
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
 * @param {number} [opts.maxFacts=100]
 * @param {number} [opts.maxChars=8000]
 * @param {object} [opts.extractors] — custom extractors by tool name: { name: (args, result) => string }
 */
export function createSessionMemory ({ maxFacts = DEFAULT_MAX_FACTS, maxChars = DEFAULT_MAX_CHARS, extractors, logger } = {}) {
  const customExtractors = extractors || null
  let facts = []
  const log = logger || { debug () {} }

  /**
   * Extract facts from messages (deterministic, no LLM).
   * Call this before messages are dropped or compacted.
   *
   * Groups messages into turn-groups and produces one fact per group
   * using tool-aware extractors for high signal density.
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
          facts.push({ text: truncate(text, 200), source: 'user', ts: first.ts || null })
        }
        continue
      }

      // Assistant with tool calls — compress entire turn-group into one fact
      if (first.role === 'assistant' && first.toolCalls?.length) {
        const resultMap = buildResultMap(group)
        const summaries = first.toolCalls.map(tc => summarizeToolCall(tc, resultMap.get(tc.id), customExtractors))
        const reasoning = textOf(first).trim()
        let text = summaries.join('; ')
        if (reasoning) text = truncate(reasoning, 100) + ' → ' + text
        facts.push({ text: truncate(text, 300), source: 'turn', ts: first.ts || null })
        continue
      }

      // Standalone assistant (no tools) — reasoning/answer
      if (first.role === 'assistant') {
        const text = textOf(first).trim()
        if (text && text.length > 20) {
          facts.push({ text: truncate(text, 300), source: 'assistant', ts: first.ts || null })
        }
        continue
      }

      // Orphan tool_result (shouldn't happen after segmentation, but be safe)
      if (first.role === 'tool') {
        const content = textOf(first)
        if (content.length > 50 && !content.startsWith(COMPACT_MARKER)) {
          facts.push({ text: `${first.toolName || 'tool'}(): ${truncate(content, 100)}`, source: 'tool', ts: first.ts || null })
        }
      }
    }

    const trimmed = trimFacts()
    const totalChars = facts.reduce((s, f) => s + f.text.length, 0)
    log.debug({ extracted: facts.length - before + trimmed, kept: facts.length, chars: totalChars, maxChars }, '[session-memory] extracted new facts')
  }

  /**
   * Format session memory for system prompt injection.
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

  function load (json) {
    if (!json || !Array.isArray(json.facts)) return
    facts = json.facts.filter(f => f && typeof f.text === 'string')
    trimFacts()
  }

  function toJSON () {
    return { facts: [...facts], version: 1 }
  }

  function trimFacts () {
    let dropped = 0
    while (facts.length > maxFacts) { facts.shift(); dropped++ }
    let total = facts.reduce((s, f) => s + f.text.length, 0)
    while (total > maxChars && facts.length > 0) {
      total -= facts.shift().text.length
      dropped++
    }
    if (dropped) log.debug({ dropped }, '[session-memory] budget pressure — dropped oldest facts')
    return -dropped
  }

  return { extract, format, getFacts, load, toJSON }
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
