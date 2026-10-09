/**
 * BM25 — the default backend, and not a placeholder.
 *
 * It needs no model call, so it costs nothing, adds no latency to a turn, and leaves no
 * sidecar to fall out of step with the notes it indexes. That is why it is the default
 * rather than the fallback: an embedding backend joins it behind the same interface, it
 * does not supersede it.
 *
 * It scores a document against a query by summing one contribution per query term, and
 * each of its three parts fixes a specific failure of counting words:
 *
 *   - **saturating term frequency** — a chunk saying "Sony" twenty times is not twenty
 *     times more relevant than one saying it once, so repetition stops paying. `k1` sets
 *     how fast.
 *   - **inverse document frequency** — a word in every chunk carries no information and a
 *     word in one is diagnostic. This is most of the signal.
 *   - **length normalisation** — a long chunk matches more terms by accident, so the
 *     score divides by relative length. `b` sets how much. This is why a fact buried in a
 *     session ranks at half what the same fact ranks alone, and therefore why the unit a
 *     thing is indexed at matters as much as the scoring does.
 *
 * What it cannot do is the whole case for embeddings: ask "what was my major?" of a chunk
 * saying "a degree in Business Administration" and the score is zero, not low. Words are
 * not a proxy for meaning here, they are the entire mechanism.
 */

const K1 = 1.5
const B = 0.75

// The usual short list. Common words carry no signal and dominate a score built from
// overlap; IDF suppresses them anyway, so this is economy rather than correctness.
const STOP = new Set(('a an the and or but if then than that this these those i me my we our you your he she it they them his her its their is are was were be been being do does did have has had can could will would should may might must of in on at to for with from by about as into over after before during not no yes so just').split(' '))

/**
 * Words, in whatever script they are written.
 *
 * This matched `/[a-z0-9']+/g`, so a Chinese, Arabic, Cyrillic or Japanese query produced
 * no terms at all and matched nothing however plainly it was stored — a 29-character
 * Chinese note about Kyoto was in the index and unreachable. `Intl.Segmenter` knows where
 * words end in scripts that do not use spaces, which is the part a regular expression
 * cannot do.
 *
 * The old three-character minimum went with it: it existed to drop noise, stopwords
 * already do that for English, and it silently discarded every short identifier and most
 * CJK words, which are one or two characters each.
 */
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' })

export const terms = (text) => {
  const words = []
  for (const { segment, isWordLike } of SEGMENTER.segment(String(text).toLowerCase())) {
    if (isWordLike && !STOP.has(segment)) words.push(segment)
  }
  return words
}

/**
 * Build an index over documents. Returns a `query` that scores every document, in the
 * order it was given them — the store decides what to do with the scores.
 *
 * `query` is async because an embedding backend's will have to be, and a synchronous
 * interface that later grows an await is a change to every caller.
 */
export function bm25 (documents) {
  const docs = documents.map(document => terms(document.text))
  const total = docs.length
  const average = total ? docs.reduce((n, doc) => n + doc.length, 0) / total : 0

  const frequency = new Map()
  for (const doc of docs) for (const word of new Set(doc)) frequency.set(word, (frequency.get(word) || 0) + 1)

  const counts = docs.map(doc => {
    const seen = new Map()
    for (const word of doc) seen.set(word, (seen.get(word) || 0) + 1)
    return seen
  })

  return {
    size: total,
    async query (text) {
      const wanted = terms(text)
      return docs.map((doc, i) => {
        let score = 0
        for (const word of wanted) {
          const appears = frequency.get(word)
          if (!appears) continue
          const idf = Math.log(1 + (total - appears + 0.5) / (appears + 0.5))
          const f = counts[i].get(word) || 0
          if (!f) continue
          score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (doc.length / (average || 1))))
        }
        return score
      })
    }
  }
}
