export function createDelivery ({ sleep, signal, now = Date.now, giveUpMs = 10 * 60_000 }) {
  const chains = new Map()

  const attempt = async (step) => {
    const started = now()
    let backoff = 1000
    for (;;) {
      try {
        return await step()
      } catch (err) {
        if (!err.retryable || signal.aborted || now() - started > giveUpMs) throw err
        const after = err.context?.retryAfter
        await sleep(after ? after * 1000 : backoff)
        if (signal.aborted) throw err
        backoff = Math.min(backoff * 2, 60_000)
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
