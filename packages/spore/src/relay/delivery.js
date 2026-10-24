import { SporeError } from '../index.js'

/**
 * A platform call that failed, as the relay reads one: `<KIND>_FAILED` unless `type` says
 * otherwise, whether trying again may work, and `context: { status, code, retryAfter }`, the HTTP
 * status, the platform's own code and the seconds it asked to be left alone, each null when the
 * platform did not say.
 */
export function platformFailed (kind, what, { detail, retryable, status = null, code = null, retryAfter = null, type = `${kind.toUpperCase()}_FAILED` }) {
  return new SporeError(`${kind} ${what} failed`, { type, detail, retryable, context: { status, code, retryAfter } })
}

/** The seconds a response's `retry-after` header asks for, or null when it names none. */
export function retryAfterOf (response) {
  const after = Number(response.headers.get('retry-after'))
  return Number.isFinite(after) && after > 0 ? after : null
}

/**
 * How long to wait before trying again: 1 s, doubled each time up to a minute, or the
 * `retryAfter` seconds a refusal names; `reset()` once a try has worked.
 */
export function backoff () {
  let next = 1000
  return {
    after (err) {
      const named = err?.context?.retryAfter
      const ms = named ? named * 1000 : next
      next = Math.min(next * 2, 60_000)
      return ms
    },
    reset () { next = 1000 }
  }
}

export function createDelivery ({ sleep, signal, now = Date.now, giveUpMs = 10 * 60_000 }) {
  const chains = new Map()

  const attempt = async (step) => {
    const started = now()
    const retry = backoff()
    for (;;) {
      try {
        return await step()
      } catch (err) {
        if (!err.retryable || signal.aborted || now() - started > giveUpMs) throw err
        await sleep(retry.after(err))
        if (signal.aborted) throw err
      }
    }
  }

  const to = (conversation, work) => {
    const next = (chains.get(conversation) ?? Promise.resolve()).then(() => work(attempt))
    const settled = next.catch(() => {})
    chains.set(conversation, settled)
    settled.then(() => { if (chains.get(conversation) === settled) chains.delete(conversation) })
    return next
  }

  return { to, attempt }
}
