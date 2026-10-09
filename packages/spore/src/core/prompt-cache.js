/**
 * The conversation half of prompt caching. `system-prompt.js` places the breakpoints in
 * the system blocks; this places the one at the end of the replayed conversation, which
 * is what makes a resumed turn cheap. Full reasoning: ARCHITECTURE.md, "Prompt caching".
 */

/**
 * Tag the last conversation message with a `cache` marker — mohdel's opt-in for
 * conversation-prefix caching on providers that need explicit breakpoints. Skipped when
 * there is no replayed history: a single-message call would pay the cache-write premium
 * with nothing ever reading it back. Content arrays are copied, not mutated — they are
 * shared with the caller's persistent transcript.
 */
export function markConversationForCaching (messages, ttl) {
  const conversational = messages.filter(m => m.role !== 'system')
  if (conversational.length < 2) return
  const last = conversational[conversational.length - 1]
  if (typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content, cache: ttl }]
    return
  }
  if (!Array.isArray(last.content)) return
  for (let i = last.content.length - 1; i >= 0; i--) {
    if (last.content[i]?.type === 'text') {
      const copy = [...last.content]
      copy[i] = { ...copy[i], cache: ttl }
      last.content = copy
      return
    }
  }
}
