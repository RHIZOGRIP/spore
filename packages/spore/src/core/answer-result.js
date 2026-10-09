/**
 * Shared handling of a mohdel `answer()` result: usage accounting and the
 * empty-completion retry.
 */

// A model can return a degenerate completion: end_turn with no text and no
// tool call (mohdel `output: null`). That is never a usable answer, so rather
// than return it as final, nudge the model a bounded number of times. Capped so
// a model that keeps returning empty still terminates.
export const MAX_EMPTY_RETRIES = 2

/**
 * Accumulate one call's usage into the running tally and emit the per-call
 * `usage` event. Returns this call's input-token count (callers track it as
 * `lastInputTokens` to drive compaction headroom).
 *
 * @param {object} res                 — mohdel AnswerResult
 * @param {object} args
 * @param {object} args.usage          — running tally (mutated in place)
 * @param {(event: string, data: object) => void} args.emit
 * @param {string} args.modelId        — model id for the usage event
 * @param {number} args.elapsedMs      — wall-time of the call
 * @returns {number}                   — res.inputTokens || 0
 */
export function accountUsage (res, { usage, emit, modelId, elapsedMs }) {
  usage.input += res.inputTokens || 0
  usage.output += res.outputTokens || 0
  usage.thinking += res.thinkingTokens || 0
  usage.cacheWrite += res.cacheWriteInputTokens || 0
  usage.cacheRead += res.cacheReadInputTokens || 0
  // Sum per-call cost from mohdel (already tier-resolved at the provider call).
  // Recomputing from aggregated tokens would misapply tiered pricing.
  usage.cost += res.cost || 0

  emit('usage', {
    model: modelId,
    input: res.inputTokens || 0,
    output: res.outputTokens || 0,
    thinking: res.thinkingTokens || 0,
    cacheWrite: res.cacheWriteInputTokens || 0,
    cacheRead: res.cacheReadInputTokens || 0,
    cost: res.cost || 0,
    elapsedMs,
    maxInterFrameMs: res.maxInterFrameMs || 0,
    idleEventCount: res.idleEventCount || 0,
    idleMaxMs: res.idleMaxMs || 0
  })

  return res.inputTokens || 0
}

/**
 * Decide what to do with a NON-tool-use completion: if it's degenerate (blank
 * text) and we have retries left, nudge for a real answer and signal the caller
 * to loop again; otherwise it's the final answer. The caller owns the message
 * sink (so loop.js and run-turn persist differently) and the loop control flow.
 *
 * @param {object} res                       — mohdel AnswerResult (non-tool-use)
 * @param {object} args
 * @param {{retries: number}} args.emptyState — per-turn retry counter (mutated)
 * @param {(event: string, data: object) => void} args.emit
 * @param {(message: object) => void} args.append — push+persist one message
 * @param {object} args.logger
 * @param {number} args.round
 * @returns {boolean}                         — true → retry, false → treat as final
 */
export function resolveEmptyCompletion (res, { emptyState, emit, append, logger, round }) {
  const output = res.output
  const blank = output == null || String(output).trim() === ''
  if (blank && emptyState.retries < MAX_EMPTY_RETRIES) {
    emptyState.retries++
    logger.warn({ round, retry: emptyState.retries }, '[loop] empty completion — nudging for a response')
    emit('empty_completion', { round, retry: emptyState.retries })
    append({ role: 'assistant', content: '(no response)' })
    append({ role: 'user', content: 'Your previous response was empty. Provide your response now.' })
    return true
  }
  return false
}
