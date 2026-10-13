/**
 * Recovery supervisor — wraps model.answer() with retry and error classification.
 *
 * Handles:
 *   - RATE_LIMIT_TIER (caller's account/quota exhausted) → fall back to next
 *     model in the chain. The exhausted model is consumed (shifted out) for
 *     the rest of the turn. When the chain has only one model left, falls
 *     through to retryable backoff. New user message → fresh chain (callers
 *     rebuild `models` from `modelIds` per call).
 *   - Other retryable errors (RATE_LIMIT_LOAD, plain 429, 503 overloaded) →
 *     backoff + retry on the same model.
 *   - Context overflow → compact + retry.
 *   - Timeout → retry once.
 *   - Fatal errors (auth, invalid request) → throw immediately.
 *   - Unknown errors → retry once, then throw.
 */

import { effectiveContextLimit } from 'mohdel'

import { compactIfNeeded, dropOldestTurnGroup } from './context-guard.js'
import { CONTEXT_NOTICE, mark } from '../core/marks.js'
import { SporeError } from '../observability/errors.js'

const MAX_RETRIES = 3
const MAX_OVERFLOW_DROPS = 50
const BACKOFF_BASE_MS = 1000

/**
 * Wrap a model chain with recovery behavior. Returns a new object with the
 * same interface but resilient answer().
 *
 * `models` is mutated in place: on RATE_LIMIT_TIER, the head is shifted
 * out so subsequent calls go to the next model. The chain's lifetime is the
 * caller's `runSpore` call — i.e. one user turn — so a fresh user message
 * starts with the full chain again.
 *
 * @param {object[]} models — non-empty array of mohdel model proxies
 * @param {object} opts
 * @param {Array} opts.messages — messages array (for compaction on overflow)
 * @param {object} [opts.logger]
 * @returns {object} wrapped model with resilient answer()
 */
export function withRecovery (models, { messages, sessionMemory, logger, emitter, signal, backoffMs = BACKOFF_BASE_MS } = {}) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('withRecovery: models must be a non-empty array')
  }
  const log = logger || { debug () {}, info () {}, warn () {}, error () {} }
  const emit = (type, data) => emitter?.emit?.(type, data)

  return {
    info: () => models[0].info?.(),
    get id () { return models[0].id },
    answer: async (prompt, opts) => {
      let lastError
      let attempt = 0
      let overflowDrops = 0

      while (attempt <= MAX_RETRIES) {
        if (signal?.aborted) {
          throw new SporeError('operation cancelled', {
            type: 'OPERATION_CANCELLED',
            detail: 'The operation was cancelled.',
            severity: 'info'
          })
        }
        try {
          // Bracket retries with diagnostic log lines so silence after
          // a `[recovery] retryable error` becomes interpretable in
          // postmortems. Without these, the log gap between
          // "scheduling retry" and "success or next failure" can stretch
          // for many minutes (a hung second answer() call) and we can't
          // tell whether the retry fired, succeeded silently, or was
          // killed by the parent.
          if (attempt > 0) {
            log.debug({ attempt, maxRetries: MAX_RETRIES }, '[recovery] retry firing')
          }
          // Built again on every attempt: an overflow is answered by compacting or dropping
          // `messages`, and a prompt taken once would retry exactly what overflowed.
          const result = await models[0].answer(typeof prompt === 'function' ? prompt() : prompt, opts)
          if (attempt > 0) {
            log.info({ attempt }, '[recovery] retry succeeded')
          }
          return result
        } catch (err) {
          lastError = err

          // A refusal that names its wait is waited out rather than retried on the backoff: a
          // provider cooldown outlasts every backoff step, and a wait is not a failure, so it
          // spends none of the retries. The turn's wall still bounds it, through `signal`.
          if (err.retryable && Number.isFinite(err.retryAfterMs) && !(err.type === 'RATE_LIMIT_TIER' && models.length > 1)) {
            log.warn({ err, delay: err.retryAfterMs }, '[recovery] told how long to wait, waiting')
            emit('recovery', { action: 'wait', reason: err.type || 'RETRYABLE_ERROR', delay: err.retryAfterMs })
            await interruptibleSleep(err.retryAfterMs, signal)
            continue
          }

          const hasNext = models.length > 1
          const kind = classify(err, hasNext)

          if (kind === 'fallback') {
            const from = models[0].id
            models.shift()
            const to = models[0].id
            log.warn({ err, from, to }, '[recovery] caller quota exhausted, falling back to next model')
            emit('recovery', { action: 'fallback', from, to })
            // Skip backoff — the new model is fresh and on a different
            // provider (or at least a different account/key). attempt
            // counter is NOT incremented; a fallback is not a "retry"
            // of the same call.
            continue
          }

          if (kind === 'overflow') {
            log.warn({ err, overflow: overflowDrops + 1 }, '[recovery] context overflow — compacting')
            const contextLimit = effectiveContextLimit(models[0].info?.())

            if (contextLimit && messages) {
              // Stage 1: marker compaction
              const compacted = compactIfNeeded(messages, {
                contextLimit,
                budgetRatio: 0.5,
                protectTail: 0,
                logger
              })
              if (compacted > 0) {
                emit('recovery', { action: 'compact', compacted })
                continue
              }

              // Stage 2: extract session memory + drop oldest turn-group
              const beforeDrop = sessionMemory
                ? (msgs) => sessionMemory.extract(msgs)
                : undefined
              const dropped = dropOldestTurnGroup(messages, { beforeDrop })
              if (dropped > 0) {
                overflowDrops++
                const kept = sessionMemory?.format?.() || null
                const factCount = sessionMemory?.getFacts?.()?.length || 0
                log.warn({ err, dropped, remaining: messages.length }, '[recovery] dropped messages (turn-group)')
                emit('recovery', { action: 'drop', dropped, remaining: messages.length, factCount })
                // The facts go in the notice, not just their number: they came from
                // messages this turn can no longer see, so nothing else carries them.
                messages.push(mark({
                  role: 'user',
                  content: kept
                    ? `[System: context was reduced to fit budget. What was dropped, in brief:\n${kept}\nRe-read anything you need in full.]`
                    : '[System: context was reduced to fit budget. Re-read anything you need in full.]'
                }, CONTEXT_NOTICE))
                if (overflowDrops >= MAX_OVERFLOW_DROPS) {
                  log.error({ limit: MAX_OVERFLOW_DROPS }, '[recovery] overflow drop limit reached')
                  throw err
                }
                continue
              }
            }

            // Nothing left to compact or drop
            throw err
          }

          if (kind === 'cancelled') throw err

          if (kind === 'fatal') {
            log.error({ err }, '[recovery] fatal error')
            throw err
          }

          if (kind === 'retryable') {
            attempt++
            if (attempt > MAX_RETRIES) throw err
            const delay = backoffMs * Math.pow(2, attempt - 1)
            log.warn({ err, delay, attempt, maxRetries: MAX_RETRIES }, '[recovery] retryable error, waiting')
            emit('recovery', { action: 'retry', reason: err.type || 'RETRYABLE_ERROR', attempt, delay })
            await interruptibleSleep(delay, signal)
            continue
          }

          // Unknown — retry once
          if (attempt === 0) {
            attempt++
            log.warn({ err }, '[recovery] unexpected error, retrying once')
            emit('recovery', { action: 'retry', reason: err.type || 'UNEXPECTED_ERROR', attempt, delay: backoffMs })
            await interruptibleSleep(backoffMs, signal)
            continue
          }

          throw err
        }
      }
      throw lastError
    }
  }
}

/**
 * Classify error for recovery. Uses CS-MESSAGE-FORMAT conventions:
 * - message = machine key for programmatic branching
 * - retryable = boolean retry signal
 * - detail !== undefined = typed error (duck-typing check)
 *
 * Untyped errors (socket transport, system) use status code fallback.
 *
 * `OPERATION_CANCELLED` is an ending someone asked for: passed on as it came, logged as no error.
 *
 * `RATE_LIMIT_TIER` (mohdel >= 0.105.0) means the caller's own quota
 * dimension is exhausted on this provider — retrying inside the
 * rate-limit window can't succeed. When there's a next model in the
 * chain, we return `'fallback'`; otherwise we let it fall through to
 * `'retryable'` so the regular backoff path runs (and ultimately
 * exhausts after MAX_RETRIES).
 */
function classify (err, hasNext) {
  if (err.type === 'OPERATION_CANCELLED') return 'cancelled'
  if (err.type === 'CONTEXT_OVERFLOW') return 'overflow'
  if (err.type === 'RATE_LIMIT_TIER' && hasNext) return 'fallback'
  if (err.retryable) return 'retryable'
  if (err.detail !== undefined) return 'fatal'

  // Untyped errors (socket transport, system errors): status code fallback
  const status = err.status || err.statusCode
  if (status === 429 || status === 503 || status === 529) return 'retryable'
  if (status === 400 || status === 401 || status === 403) return 'fatal'

  return 'unknown'
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function interruptibleSleep (ms, signal) {
  if (!signal) return sleep(ms)
  return Promise.race([
    sleep(ms),
    new Promise((_resolve, reject) => {
      if (signal.aborted) { reject(new Error('Cancelled')); return }
      signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true })
    })
  ])
}
