/**
 * System prompt composition — deterministic ordering and explicit cache breakpoints.
 *
 * Block layout (stable → volatile, each line is one provider block):
 *
 *   1. identity + domainRules   ← cache `cacheTtl` (foundation)
 *   2. substrate                ← cache '5m', emitted only when non-empty
 *   3. sessionMemory            ← cache '5m', emitted only when non-empty
 *   4. caller-supplied dynamic blocks (0..N, each with its own cache hint)
 *
 * The cache key is a prefix hash up to each breakpoint. Anything that
 * mutates must come AFTER the cached blocks at that tier, otherwise
 * the cached prefix is invalidated when the content changes.
 *
 * `dynamic` accepts either:
 *   - a string  — back-compat: one uncached tail block
 *   - an array of `{ text, cache? }` blocks — caller composes per-block
 *     cache life. Each entry becomes its own provider block;
 *     entries with `cache: '5m' | '1h'` open a cache breakpoint.
 *     Caller is responsible for stability-first ordering (most-stable
 *     first) — Anthropic's prefix-hash cache invalidates everything
 *     after the first mutated block.
 *
 * Anthropic caps cache breakpoints at 4 per request. Spore-internal
 * uses at most 3 (foundation always, substrate + sessionMemory only
 * when non-empty), leaving 1+ for the caller.
 *
 * Returns an array of mohdel blocks: [{ text, cache? }, ...].
 * mohdel converts `cache: '5m' | '1h'` to provider-specific cache_control.
 */

const BOUNDARY_FOUNDATION = '\n\n──── CACHED PREFIX BOUNDARY ────\n\n'
const BOUNDARY_DYNAMIC = '\n\n──── CACHE-FRESH (per session) ────\n\n'

/**
 * @param {object} slots
 * @param {string} [slots.identity]      - who the agent is told it is
 * @param {string} [slots.domainRules]   - pipeline rules, e.g. interview protocol
 * @param {string} [slots.substrate]     - workspace knowledge from disk
 * @param {string} [slots.sessionMemory] - extracted facts (formatted)
 * @param {string} [slots.dynamic]       - per-turn delta (date, env, etc.)
 * @param {object} [opts]
 * @param {'5m'|'1h'} [opts.cacheTtl='5m'] - cache TTL for the foundation breakpoint
 * @returns {Array<{text: string, cache?: '5m'|'1h'}>}
 */
export function composeSystem (slots = {}, opts = {}) {
  const { identity, domainRules, substrate, sessionMemory, dynamic } = slots
  const cacheTtl = opts.cacheTtl || '5m'
  const blocks = []

  // Block 1: foundation — identity + domainRules concatenated into one block
  // (they have the same half-life, share one cache breakpoint)
  const foundationParts = []
  if (identity) foundationParts.push(identity)
  if (domainRules) foundationParts.push(domainRules)
  if (foundationParts.length) {
    blocks.push({
      text: foundationParts.join('\n\n') + BOUNDARY_FOUNDATION,
      cache: cacheTtl
    })
  }

  // Block 2: substrate — workspace knowledge. Stable across sessions
  // in the same workspace, so it gets its own breakpoint to allow
  // cross-session reuse of its cached bytes.
  if (substrate) {
    blocks.push({
      text: substrate + BOUNDARY_DYNAMIC,
      cache: '5m'
    })
  }

  // Block 3: sessionMemory — auto-extracted facts. Volatile within a
  // session but stable across rounds of the same turn, so it deserves
  // its own breakpoint independent of substrate. Sharing with substrate
  // would force the more-volatile party's life onto both and destroy
  // substrate's cross-session reuse.
  if (sessionMemory) {
    blocks.push({
      text: sessionMemory,
      cache: '5m'
    })
  }

  // Block 4..N: caller-supplied dynamic content. Either a single string
  // (back-compat: one uncached tail) or an array of `{ text, cache? }`
  // blocks. Empty / blank entries are dropped so they don't open
  // useless cache breakpoints.
  if (typeof dynamic === 'string' && dynamic) {
    blocks.push({ text: dynamic })
  } else if (Array.isArray(dynamic)) {
    for (const entry of dynamic) {
      if (!entry || !entry.text) continue
      const block = { text: entry.text }
      if (entry.cache === '5m' || entry.cache === '1h') block.cache = entry.cache
      blocks.push(block)
    }
  }

  return blocks
}
