/**
 * Transcript integrity — sanitize messages before sending to model.
 *
 * Handles:
 *   1. Orphaned tool_results (no matching assistant toolCall) → dropped
 *   2. Unpaired assistant toolCalls (no matching tool_result) → synthetic error result added
 *   3. Duplicate tool_results for same toolCallId → keep first, drop rest
 *   4. Oversized tool_result content → truncated
 *   5. Empty/null content normalization
 *
 * Caller must pass logger (use silent from logger.js for no output).
 */

import { effectiveContextLimit } from 'mohdel'

import { textOf } from '../core/message.js'
import { refusedResult } from '../core/refusal.js'

import { silent } from '../observability/logger.js'

const FALLBACK_MAX_RESULT_SIZE = 50000
const RESULT_BUDGET_RATIO = 0.10 // 10% of context per single tool result
const CHARS_PER_TOKEN = 4
const TRUNCATION_NOTICE = '\n\n[truncated — output exceeded size limit]'

/**
 * Compute max tool result size from model context limit.
 * @param {number} contextTokenLimit
 */
export function maxResultSizeForContext (contextTokenLimit) {
  if (!contextTokenLimit) return FALLBACK_MAX_RESULT_SIZE
  return Math.max(4000, Math.floor(contextTokenLimit * RESULT_BUDGET_RATIO * CHARS_PER_TOKEN))
}

/**
 * Compute context/budget figures from a model proxy: the `compactIfNeeded`
 * threshold and the transcript truncation cap `loop()` applies each round.
 *
 * @param {object} model — mohdel model proxy
 * @returns {{ contextLimit: number, maxResultSize: number }}
 */
export function computeBudget (model) {
  const info = model?.info?.() || {}
  const contextLimit = effectiveContextLimit(info)
  const maxResultSize = maxResultSizeForContext(contextLimit)
  return { contextLimit, maxResultSize }
}

/**
 * Cut a result down to size without making it unreadable. A call record keeps its
 * shape and loses its largest field; anything else is a string and gets sliced.
 */
function compactResult (content, limit) {
  try {
    const record = JSON.parse(content)
    if (record && typeof record === 'object' && !Array.isArray(record)) {
      const widest = Object.entries(record)
        .filter(([, value]) => typeof value === 'string')
        .sort((a, b) => b[1].length - a[1].length)[0]
      if (widest) {
        const [key] = widest
        const kept = { ...record, [key]: undefined, dropped: `${key} (${widest[1].length} chars) — over the ${limit} character budget, read it from the file` }
        const compacted = JSON.stringify(kept)
        if (compacted.length <= limit) return compacted
      }
    }
  } catch {}
  return content.slice(0, limit) + TRUNCATION_NOTICE
}

/**
 * Sanitize a messages array in-place before sending to the model.
 * Returns the same array (mutated) for convenience.
 *
 * @param {Array} messages
 * @param {object} [opts]
 * @param {number} [opts.maxResultSize=50000] — max chars per tool_result content
 * @param {object} [opts.logger]
 * @returns {Array} the sanitized messages array
 */
export function sanitizeTranscript (messages, { maxResultSize = FALLBACK_MAX_RESULT_SIZE, logger = silent } = {}) {
  // Collect all toolCallIds declared by assistant messages
  const declaredCalls = new Set()
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) declaredCalls.add(tc.id)
    }
  }

  // Collect all toolCallIds that have a tool_result
  const resolvedCalls = new Set()
  const seenResults = new Set()

  // Pass 1: drop orphaned/duplicate tool_results, truncate oversized
  let i = 0
  while (i < messages.length) {
    const msg = messages[i]

    if (msg.role === 'tool') {
      const id = msg.toolCallId

      // Drop if no matching assistant toolCall
      if (id && !declaredCalls.has(id)) {
        logger.debug({ toolCallId: id }, '[transcript] dropping orphaned tool_result')
        messages.splice(i, 1)
        continue
      }

      // Drop duplicate
      if (id && seenResults.has(id)) {
        logger.debug({ toolCallId: id }, '[transcript] dropping duplicate tool_result')
        messages.splice(i, 1)
        continue
      }

      if (id) {
        seenResults.add(id)
        resolvedCalls.add(id)
      }

      // Truncate oversized content. Tools budget their
      // own result, so this is the backstop for anything that did not — and it has to
      // leave something the model can still read. Slicing a call record's JSON at a
      // byte count produced a truncation marker glued to half an object.
      // Truncating collapses parts to the text: a result too big to carry whole is one
      // whose image was the expensive half.
      const text = textOf(msg)
      if (text.length > maxResultSize) {
        logger.debug({ chars: text.length, limit: maxResultSize, tool: msg.toolName }, '[transcript] truncating tool_result')
        msg.content = compactResult(text, maxResultSize)
      }

      // Normalize null/undefined content
      if (msg.content == null) msg.content = ''
    }

    // Normalize assistant content
    if (msg.role === 'assistant' && msg.content == null) {
      msg.content = ''
    }

    i++
  }

  // Pass 2: add synthetic error results for unpaired toolCalls
  // Iterate backwards to keep splice indices stable
  for (let j = messages.length - 1; j >= 0; j--) {
    const msg = messages[j]
    if (msg.role !== 'assistant' || !msg.toolCalls?.length) continue

    // Find the end of tool_results that follow this assistant message
    let insertAt = j + 1
    while (insertAt < messages.length && messages[insertAt].role === 'tool') insertAt++

    // Add missing results at the end of the block (reverse order to maintain toolCall order)
    const missing = msg.toolCalls.filter(tc => !resolvedCalls.has(tc.id)).reverse()
    for (const tc of missing) {
      logger.debug({ toolCallId: tc.id, toolName: tc.name }, '[transcript] adding synthetic error result for unpaired toolCall')
      messages.splice(insertAt, 0, refusedResult(tc.id, tc.name, 'tool execution was interrupted (no result recorded)'))
      resolvedCalls.add(tc.id)
    }
  }

  return messages
}
