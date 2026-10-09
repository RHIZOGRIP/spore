/**
 * Long-term memory in a vector store. The chunks are embedded here, through the tree's model
 * socket like any other model call, and the vectors go to the store socket; the collection, and
 * the credential that reaches it, are the runner's.
 */

import { createHash } from 'node:crypto'

import { SporeError } from '../observability/errors.js'
import { createStoreClient } from '../infra/store-client.js'

export const MAX_TOP_K = 50000
export const FALLBACK_BATCH = 96
// Deliberately below the usual four: a piece that is too short costs an extra vector, one
// that is too long costs the whole call, and CJK runs far denser than English.
export const CHARS_PER_TOKEN = 2

/**
 * A turn-unit chunk is a whole message or markdown section, and one was measured at 76,770
 * bytes against an 8,191-token window. Truncating would leave the tail of that section
 * unreachable with nothing to say so, so it is split instead: every piece is embedded and
 * stored, and a hit on any of them is a hit on the chunk. The pieces share the chunk's id
 * with a suffix, which is what lets a match be traced back to it.
 *
 * The cut falls at the last boundary that fits, because a vector built from a fragment
 * beginning mid-clause stands for something nobody wrote: after a sentence, then at a line,
 * then at a space, and only failing all three at the window itself.
 *
 * Deliberately not `chunks.js`'s `sentences()`, which trims, drops fragments carrying no
 * letters, and treats every newline as a break. That is right for making a sentence chunk
 * and wrong for dividing one: pieces here are contiguous slices, so indentation, line
 * structure and spacing survive and the pieces rejoin to exactly the original.
 */
const breakIn = (window) => {
  const ends = [...window.matchAll(/[.!?]\s+/g)]
  const sentence = ends.at(-1)
  if (sentence && sentence.index > 0) return sentence.index + sentence[0].length
  const line = window.lastIndexOf('\n')
  if (line > 0) return line + 1
  const space = window.lastIndexOf(' ')
  if (space > 0) return space + 1
  return window.length
}

export const piecesOf = (text, ceiling) => {
  if (!ceiling || text.length <= ceiling) return [text]

  const pieces = []
  let from = 0
  while (from < text.length) {
    if (text.length - from <= ceiling) {
      pieces.push(text.slice(from))
      break
    }
    const cut = breakIn(text.slice(from, from + ceiling))
    pieces.push(text.slice(from, from + cut))
    from += cut
  }
  return pieces
}

export const parentOf = (id) => id.replace(/\.\d+$/, '')

const digest = (parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')

export const recordIdOf = (unit, chunk) => digest([unit, chunk.anchor.path, chunk.anchor.line, chunk.text])

/**
 * The entry decides the width the collection is made at, the batch a call may carry and the window a
 * piece must fit, so an entry that says nothing about width is refused rather than guessed.
 */
function embedderFor (mo, embedding, signal) {
  const model = mo.use(embedding)
  const spec = model.info()
  if (!spec) {
    throw new SporeError(`the catalog knows nothing about ${embedding}`, {
      type: 'STORE_EMBEDDING_UNKNOWN',
      detail: 'embedding: in the definition names a catalog embedding model'
    })
  }
  if (!spec.dimensions) {
    throw new SporeError(`${embedding} does not say how wide its vectors are`, {
      type: 'STORE_WIDTH_UNKNOWN',
      detail: 'a collection is made at one width, so its catalog entry needs dimensions'
    })
  }
  const width = spec.dimensions
  const batch = spec.maxBatch || FALLBACK_BATCH
  return {
    width,
    ceiling: (spec.maxInputTokens || 0) * CHARS_PER_TOKEN,
    // A symmetric model rejects a role rather than ignoring it, so one is sent only to an
    // entry that maps it.
    async embed (texts, inputType) {
      const options = spec.inputTypes?.[inputType] ? { inputType } : {}
      const vectors = []
      for (let at = 0; at < texts.length; at += batch) {
        const result = await model.embed(texts.slice(at, at + batch), { ...options, signal })
        if (result.dimensions !== width) {
          throw new SporeError(`${embedding} returned ${result.dimensions} dimensions where its catalog entry says ${width}`, {
            type: 'STORE_DIMENSION_MISMATCH',
            detail: 'a collection holds one width, so these vectors cannot be stored beside the rest'
          })
        }
        vectors.push(...result.vectors)
      }
      return vectors
    }
  }
}

export function vectors (documents, { unit, socket, key, mo, embedding, connect = createStoreClient } = {}) {
  if (!socket) {
    throw new SporeError('the vectors backend has no store to reach', {
      type: 'STORE_UNCONFIGURED',
      detail: 'SPORE_STORE_SOCKET is unset, so nothing here can reach the store without holding its token'
    })
  }

  // Two chunks can be the same record: sentences split from one line all carry that line as
  // their anchor, so an identical sentence twice on it hashes identically. The store takes
  // each id once — it refuses a batch holding a duplicate — and a hit has to score every
  // position that shares the id, not just the last one to be seen.
  const entries = []
  const positionsOf = new Map()
  documents.forEach((chunk, at) => {
    const id = recordIdOf(unit, chunk)
    const seen = positionsOf.get(id)
    if (seen) return seen.push(at)
    positionsOf.set(id, [at])
    entries.push({ id, text: chunk.text })
  })

  return {
    size: documents.length,

    async query (text, { signal } = {}) {
      const scores = new Array(documents.length).fill(0)
      if (!documents.length) return scores

      const embedder = embedderFor(mo, embedding, signal)
      const store = connect({ socketPath: socket, key, signal })

      const pieces = entries.flatMap(entry => {
        const parts = piecesOf(entry.text, embedder.ceiling)
        return parts.map((part, at) => ({ id: parts.length > 1 ? `${entry.id}.${at}` : entry.id, text: part }))
      })
      const { held } = await store.holds(embedder.width, pieces.map(piece => piece.id))
      const present = new Set(held)
      const missing = pieces.filter(piece => !present.has(piece.id))
      if (missing.length) {
        const vectors = await embedder.embed(missing.map(piece => piece.text), 'document')
        await store.index(embedder.width, unit, missing.map((piece, at) => ({ id: piece.id, vector: vectors[at] })))
      }

      // A split chunk holds several records, so top-k can spend its slots on pieces of one
      // thing. Asked wider and collapsed to the nearest piece per chunk, which is what is
      // being ranked.
      const [vector] = await embedder.embed([text], 'query')
      const topK = Math.min(entries.length, MAX_TOP_K)
      const { matches } = await store.search(embedder.width, unit, vector, Math.min(topK * 2, MAX_TOP_K))
      const nearest = new Map()
      for (const match of matches) {
        const id = parentOf(match.id)
        const seen = nearest.get(id)
        if (seen === undefined || match.distance < seen) nearest.set(id, match.distance)
      }
      for (const [id, distance] of [...nearest].slice(0, topK)) {
        for (const at of positionsOf.get(id) || []) scores[at] = 1 - distance
      }
      return scores
    }
  }
}
