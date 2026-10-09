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
        backoff = Math.min(backoff * 2, 60_000)
      }
    }
  }

  const to = (chat, work) => {
    const next = (chains.get(chat) ?? Promise.resolve()).then(() => work(attempt))
    const settled = next.catch(() => {})
    chains.set(chat, settled)
    settled.then(() => { if (chains.get(chat) === settled) chains.delete(chat) })
    return next
  }

  return { to, attempt }
}
