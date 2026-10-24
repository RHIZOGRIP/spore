/**
 * The store — long-term memory, with two ways in and a backend that can be swapped.
 * Contract: ARCHITECTURE.md, "Memory".
 *
 * Short-term memory is the transcript: in context, bounded by the window, and meant to be
 * small. Long-term memory is this: unbounded, on disk, and never in context. All that is
 * decided here is what crosses between them.
 *
 *   **push** — the runtime queries with the incoming turn and puts the hits in front of
 *   the model unasked. Nobody decides to remember; a smell arrives and the memory comes
 *   with it. Sentence-sized and small enough to afford on every turn.
 *
 *   **pull** — the agent asks, having noticed it does not know something. Turn-sized,
 *   retrieved wide and expanded through the anchors, which is what reaches far more of
 *   the evidence than retrieving whole sessions and costs half as much.
 *
 * The agent writes nothing here. It writes markdown under `data/` as it already does and
 * the store indexes what is there, so plain files stay plain and greppable and memory
 * never becomes a thing the agent has to be taught to operate.
 *
 * Numbers come from the definition, never from here — see `.cmk` `push` and `pull`. Every
 * one of them came from a single sweep over a single dataset, so they are starting values
 * to be benchmarked, and a default buried in the runtime is a number nobody benchmarks.
 */

import { bm25 } from './bm25.js'
import { vectors } from './vectors.js'
import { chunksOf, expand, MEMORY_DIR, SENTENCE, TURN } from './chunks.js'

export const BACKENDS = { bm25, vectors }

/**
 * How much recall may weigh, in tokens.
 *
 * `push` bounds the *count* of hits and nothing bounded their size: a sentence is whatever
 * lies between two full stops, so a note written without one is a single hit of any
 * length. Measured with a 124,000-character note and `push: 1`, the first model call
 * carried 31,025 tokens of messages against a 2,000-token window — and history compaction
 * has already run by then, so nothing downstream can shrink it.
 *
 * This is a guard rather than a tuning knob, which is why it has a default where `push`
 * and `pull` deliberately do not. An oversized hit is cut rather than dropped: the excerpt
 * is usually where the match was, and the anchor still leads to the whole thing.
 */
export const RECALL_BUDGET_TOKENS = 1000

const weigh = (text) => Math.ceil(text.length / 4)

const trim = (text, tokens) =>
  (weigh(text) <= tokens ? text : text.slice(0, Math.max(0, tokens * 4 - 1)).trimEnd() + '…')

function fit (hits, budget) {
  if (!hits.length) return hits
  const each = Math.max(1, Math.floor(budget / hits.length))
  const out = []
  let spent = 0
  for (const hit of hits) {
    if (spent >= budget) break
    const text = trim(hit.text, Math.min(each, budget - spent))
    out.push(text === hit.text ? hit : { ...hit, text, truncated: true })
    spent += weigh(text)
  }
  return out
}

export { MEMORY_DIR }

/**
 * Open a store over a workspace.
 *
 * Two indexes, one per unit, because a sentence and the turn containing it are the same
 * words twice and one index holding both would count that text twice in its own
 * statistics. Both indexes hold both sources — the notes and the transcript go in
 * together, scored by one function, with provenance carried on the anchor rather than
 * arbitrated. Length normalisation then favours the notes without a rule: a curated fact
 * is one line against a turn's sixty words, and the score divides by length.
 */
export function openStore (ws, { backend = 'bm25', push = null, pull = null, floor = 0, embedding = null, horizon = Infinity, budget = RECALL_BUDGET_TOKENS, socket = null, key = null, mo = null, signal } = {}) {
  const build = BACKENDS[backend]
  if (!build) throw new Error(`unknown memory backend: ${backend} — one of ${Object.keys(BACKENDS).join(', ')}`)

  let indexes = null
  const unreadable = []

  // Rebuilt rather than persisted. At BM25 over a few hundred facts this costs nothing
  // and leaves no sidecar to drift out of step with the notes. An embedding backend
  // cannot do this — each chunk is a model call — so it will carry its own cache behind
  // the same interface, which is why this returns a handle and names no file format.
  const ready = () => {
    if (indexes) return indexes
    const units = {}
    for (const unit of [SENTENCE, TURN]) {
      // Both indexes scan the same notes; a file that cannot be read fails once.
      const found = []
      const chunks = chunksOf(ws, unit, { horizon, unreadable: found })
      for (const bad of found) {
        if (!unreadable.some(seen => seen.path === bad.path)) unreadable.push(bad)
      }
      units[unit] = { chunks, index: build(chunks, { unit, socket, key, mo, embedding }) }
    }
    indexes = units
    return indexes
  }

  // Memory is what was said *before* now. The transcript is indexed, and the turn being
  // answered is in the transcript, so without this the store's best hit is the question
  // itself — measured at 16.88 against the next chunk's 2.00, a slot of five spent
  // handing the model back what it just asked.
  const rank = async (unit, text, take) => {
    const { chunks, index } = ready()[unit]
    if (!chunks.length || !take) return []
    const scores = await index.query(text, { signal })
    return chunks
      .map((chunk, i) => ({ ...chunk, score: scores[i] }))
      .filter(hit => hit.score > floor)
      .sort((a, b) => b.score - a.score)
      .slice(0, take)
  }

  return {
    /** Notes that could not be read, so a caller can say so instead of losing them silently. */
    get unreadable () {
      return unreadable
    },

    /** What the incoming turn brings to mind, unasked. */
    async push (text, take = push) {
      return fit(await rank(SENTENCE, text, take), budget)
    },

    /**
     * What a deliberate question finds: chunks ranked as they score, each hit widened to
     * the section it is in. Repetition earns nothing — see below.
     */
    async pull (query, take = pull) {
      // Ordinary ranking, each hit widened to what surrounds it.
      //
      // This grouped hits by anchor and summed their scores, meaning to make repetition
      // count: IDF punishes a fact that is said often, scoring each mention lower, so a
      // thing mentioned twenty-five times can rank below a passing remark. The grouping
      // never fired — every chunk already has a distinct anchor, so the map only ever
      // held one entry per key — and querying `Sony Gitzo` against two Sony sections and
      // one Gitzo aside still put the aside first, 0.912 against 0.508 and 0.470.
      //
      // Making reinforcement real needs a way to tell that two sections are about the
      // same thing, which is a judgement this backend cannot make and a decision nobody
      // has taken. Summing identical keys was not that, so it is gone rather than left
      // looking like it.
      const hits = await rank(TURN, query, take)
      const sections = hits.map(hit => ({ anchor: hit.anchor, score: hit.score, text: expand(ws, hit.anchor) || hit.text }))
      // Pull is asked for and may reach wider, but a section is a whole markdown block
      // and one of those can be as long as someone cared to make it.
      return fit(sections, budget * 4)
    }
  }
}
