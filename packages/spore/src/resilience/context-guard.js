/**
 * Context budget guard — prevents context overflow by compacting old tool results.
 *
 * Strategy:
 *   1. Estimate total transcript size (chars / 4 ≈ tokens)
 *   2. If over budget threshold, compact oldest tool_result contents
 *   3. Keep message structure (role, toolCallId, toolName) but replace content
 *   4. Never compact the last N messages (active working context)
 *   5. Never compact user messages (preserve the task)
 *
 * Compaction is lossy but safe — the model sees what tools were called
 * and can re-read files if needed.
 *
 * Caller must pass logger (use silent from logger.js for no output).
 */
import { textOf } from '../core/message.js'
import { silent } from '../observability/logger.js'

const CHARS_PER_TOKEN = 4

// An image part carries no characters and about a thousand tokens, so a char count alone
// reads a page the model is looking at as free. Deliberately over rather than under: the
// guard's job is to compact early, and a cheap image counted dear costs one extra
// compaction, where a dear one counted cheap costs the turn.
const CHARS_PER_IMAGE = 6000
const COMPACT_MARKER = '[compacted — re-read if needed]'
const PROTECT_TAIL = 6 // never compact the last N messages

/**
 * Estimate token count for a messages array. A part the estimate cannot read — encrypted
 * reasoning, a provider's own item — is counted by its serialized size: over rather than
 * under, for the reason images are.
 */
export function estimateTokens (messages) {
  let chars = 0
  for (const msg of messages) {
    chars += textOf(msg).length
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part?.type === 'image') chars += CHARS_PER_IMAGE
        else if (part?.type !== 'text') chars += JSON.stringify(part).length
      }
    }
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        chars += (tc.name || '').length + JSON.stringify(tc.arguments || {}).length
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/**
 * Compact old tool_results if transcript exceeds budget.
 * Mutates messages in-place.
 *
 * @param {Array} messages
 * @param {object} opts
 * @param {number} opts.contextLimit — model's context token limit
 * @param {number} [opts.budgetRatio=0.7] — compact when transcript exceeds this ratio of contextLimit
 * @param {number} [opts.budget] — absolute token budget; overrides budgetRatio when set
 * @param {number} [opts.protectTail=6] — never compact the last N messages
 * @param {object} [opts.logger]
 * @returns {number} number of messages compacted
 */
export function compactIfNeeded (messages, { contextLimit, budgetRatio = 0.7, budget: budgetOverride, protectTail = PROTECT_TAIL, lastInputTokens, logger = silent } = {}) {
  if (!contextLimit) return 0

  const budget = budgetOverride ?? Math.floor(contextLimit * budgetRatio)
  const current = lastInputTokens || estimateTokens(messages)

  if (current <= budget) return 0

  logger.debug({ current, budget, estimated: !lastInputTokens }, '[context-guard] transcript over budget — compacting')

  const cutoff = messages.length - protectTail
  let compacted = 0

  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i]

    if (msg.role === 'tool' && textOf(msg).length > COMPACT_MARKER.length) {
      msg.content = COMPACT_MARKER
      compacted++

      if (estimateTokens(messages) <= budget) break
    }
  }

  if (compacted) {
    logger.debug({ compacted, tokens: estimateTokens(messages) }, '[context-guard] compacted tool results')
  }

  return compacted
}

/**
 * Drop the oldest complete turn-group from messages.
 * Never drops messages[0] (initial user prompt).
 *
 * A turn-group is:
 *   - assistant(toolCalls) + consecutive tool_results → all removed
 *   - standalone assistant (no toolCalls) → 1 message removed
 *   - user at index > 0 → 1 message removed
 *
 * @param {Array} messages
 * @returns {number} messages removed (0 if nothing droppable)
 */
export function dropOldestTurnGroup (messages, { beforeDrop } = {}) {
  if (messages.length <= 1) return 0

  const msg = messages[1]

  // Assistant with toolCalls: drop it + all consecutive tool_results
  if (msg.role === 'assistant' && msg.toolCalls?.length) {
    let end = 2
    while (end < messages.length && messages[end].role === 'tool') end++
    if (beforeDrop) beforeDrop(messages.slice(1, end))
    messages.splice(1, end - 1)
    return end - 1
  }

  // Standalone assistant or user at index > 0: drop 1
  if (beforeDrop) beforeDrop(messages.slice(1, 2))
  messages.splice(1, 1)
  return 1
}
