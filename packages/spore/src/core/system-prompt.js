/**
 * The system prompt — two blocks, byte for byte the same on every turn.
 *
 *   1. identity + rules   ← cache `cacheTtl` (the foundation)
 *   2. note               ← no breakpoint of its own
 *
 * A provider caches a prefix matched byte for byte, and the whole conversation comes after
 * this: a value here that changes makes all of it uncacheable on every turn. What changes per
 * turn (the clock, recall) goes in front of the turn's own message instead (ARCHITECTURE
 * §Prompt caching); `test/transcript-persistence.test.js` fails the day this is not so.
 *
 * Returns an array of mohdel blocks: [{ text, cache? }, ...].
 * mohdel converts `cache: '5m' | '1h'` to provider-specific cache_control.
 */

/**
 * @param {object} slots
 * @param {string} [slots.identity] - who the agent is told it is: the definition's body
 * @param {string} [slots.rules]    - what it can reach here, written by the runtime
 * @param {string} [slots.note]     - a constant line after the foundation
 * @param {object} [opts]
 * @param {'5m'|'1h'} [opts.cacheTtl='5m'] - cache TTL for the foundation breakpoint
 * @returns {Array<{text: string, cache?: '5m'|'1h'}>}
 */
export function composeSystem (slots = {}, opts = {}) {
  const { identity, rules, note } = slots
  const cacheTtl = opts.cacheTtl || '5m'
  const blocks = []

  // identity + rules have the same half-life, so they share one breakpoint.
  const foundationParts = []
  if (identity) foundationParts.push(identity)
  if (rules) foundationParts.push(rules)
  if (foundationParts.length) {
    blocks.push({
      text: foundationParts.join('\n\n'),
      cache: cacheTtl
    })
  }

  if (note) blocks.push({ text: note })

  return blocks
}
