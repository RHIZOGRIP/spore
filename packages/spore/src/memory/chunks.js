/**
 * Cutting a workspace into things that can be retrieved.
 *
 * Two sources, one shape. The notes are what the agent chose to keep; the transcript is
 * what was actually said. Both are indexed, because a fact the agent neglected to write
 * down is still reachable in the record — curation becomes an optimisation rather than a
 * single point of loss.
 *
 * Every chunk carries an **anchor**: a path and a position. `data/memory/person.md:12`
 * and `transcript:47` are the same shape, which is what lets one index hold both and
 * what lets a hit be expanded without searching again.
 *
 * Two units, measured rather than chosen (bench/longmemeval/README.md): a **sentence**
 * separates evidence from everything else by 22× and costs about 136 tokens for five,
 * which is what push can afford to do unasked. A **turn** recalls more and separates by
 * 16×, which is what pull wants before expanding. They are separate indexes, not one:
 * a sentence and the turn containing it are the same words twice, and one index holding
 * both would count that text twice in its own statistics.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { textOf } from '../core/message.js'

import { isTranscriptAnchor, readSaidSoFar, transcriptAnchor } from '../core/spore-dir.js'

export const SENTENCE = 'sentence'
export const TURN = 'turn'

/**
 * Anything with a letter or a digit in it. Not a length.
 *
 * This was a twenty-character floor, on the theory that short strings are headings and
 * "ok." — which also threw away `City: Oslo.` and `My pet is Margot.`, exactly the terse
 * notes the agent is told to keep. A rule about size cannot tell a fact from a fragment;
 * a rule about content can rule out the fragments that are only punctuation, and nothing
 * else needs ruling out.
 */
const meaningful = (text) => /[\p{L}\p{N}]/u.test(text)

const sentences = (text) => String(text).split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(meaningful)

/**
 * What was said, as opposed to what the plumbing recorded.
 *
 * A tool message's content is a call record — JSON, and for `read` a verbatim copy of a
 * file that is already indexed in its own right. Indexed, it returns as a blob of
 * `{"tool":"read","call":"0003",…}` occupying a slot that a sentence should have had, and
 * says nothing the file does not say better. Memory is the conversation; the trail is
 * beside it and stays there.
 */
const said = (message) => (message.role === 'tool' ? '' : textOf(message))

/** Every markdown file under a directory, with the line each piece of text starts on. */
function notesIn (ws, dir, unreadable = []) {
  const root = resolve(ws, dir)
  if (!existsSync(root)) return []
  const out = []
  // One unreadable note is one unreadable note. A dangling symlink under `data/memory/`
  // used to throw `ENOENT` out of the scanner, before the turn's own error handling
  // existed — an ordinary question died with no terminal record and nothing said why, and
  // the agent could not run to repair the file that was stopping it.
  const walk = (at) => {
    let entries
    try {
      entries = readdirSync(at, { withFileTypes: true })
    } catch (err) {
      unreadable.push({ path: relative(ws, at), why: err.code || err.message })
      return
    }
    for (const entry of entries) {
      const full = resolve(at, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!/\.(md|markdown|txt)$/i.test(entry.name)) continue
      try {
        // A symlink resolves through `statSync`, so this also refuses one pointing at a
        // directory, a device or nothing at all.
        if (!statSync(full).isFile()) continue
        if (statSync(full).size === 0) continue
        out.push({ path: relative(ws, full), lines: readFileSync(full, 'utf8').split('\n') })
      } catch (err) {
        unreadable.push({ path: relative(ws, full), why: err.code || err.message })
      }
    }
  }
  walk(root)
  return out
}

/**
 * The chunks of one unit, from both sources.
 *
 * A note's turn-sized unit is the section it sits under — the markdown heading block —
 * because that is what "the context around this fact" means in a file the agent wrote.
 * The transcript's is the message.
 */
/**
 * Memory is a place, not everything the agent writes.
 *
 * `data/` is the working directory: grep output, directory listings, half-finished
 * scratch. Indexed wholesale, a `data/scan.txt` holding one line of grep output takes a
 * slot from the note it was quoting — measured, one of five. So the store reads one
 * subdirectory and the identity names it, which also gives the agent somewhere to put
 * working files without polluting what it will be asked to remember.
 */
export const MEMORY_DIR = 'data/memory'

export function chunksOf (ws, unit, { dir = MEMORY_DIR, horizon = Infinity, unreadable = [] } = {}) {
  const chunks = []

  for (const file of notesIn(ws, dir, unreadable)) {
    if (unit === SENTENCE) {
      file.lines.forEach((line, i) => {
        // A heading names a section rather than stating anything, and as a chunk it is a
        // short line of pure keyword: `# Gear` outranked the fact beneath it for a query
        // about gear. It still bounds the section that pull returns.
        if (/^#{1,6}\s/.test(line)) return
        for (const text of sentences(line)) chunks.push({ text, anchor: { path: file.path, line: i + 1 } })
      })
      continue
    }
    // Sections: everything under a heading, anchored at the heading.
    let start = 0
    let body = []
    const flush = () => {
      const text = body.join('\n').trim()
      if (meaningful(text)) chunks.push({ text, anchor: { path: file.path, line: start + 1 } })
    }
    file.lines.forEach((line, i) => {
      if (/^#{1,6}\s/.test(line)) { flush(); start = i; body = [line]; return }
      body.push(line)
    })
    flush()
  }

  // Only what has left short-term memory. A turn still in context does not belong in the
  // store — it is already in front of the model, and indexing it lets the store answer a
  // question with the question: measured at 16.88 against the next chunk's 2.00, one slot
  // of five spent handing back what was just asked. `horizon` is the first message still
  // in context, so everything before it has been evicted and is the store's business.
  // It also makes indexing once-per-turn-ever rather than once per turn per turn, which
  // is the difference between viable and not for a backend that pays a model call a chunk.
  const messages = readSaidSoFar(ws).slice(0, horizon)
  for (const message of messages) {
    const text = said(message)
    if (!text) continue
    // The entry, so following the anchor lands on the message it came from; and who said it
    // and when, because an assistant's suggestion and the person's own statement are not
    // the same kind of thing, and "next Thursday" said in May is not a date without the May.
    const found = { anchor: transcriptAnchor(ws, message), role: message.role, when: message.at }
    if (unit === SENTENCE) {
      for (const line of sentences(text)) chunks.push({ text: line, ...found })
    } else if (meaningful(text)) {
      chunks.push({ text: text.trim(), ...found })
    }
  }

  return chunks
}

/**
 * What surrounds a hit — the section of a notes file, the neighbouring messages of a
 * transcript. Retrieving small and then following the anchor out is what reaches 80% of
 * the evidence for 8,811 tokens where retrieving whole sessions needs 15,865 for 85%.
 */
export function expand (ws, anchor, { neighbours = 1 } = {}) {
  if (isTranscriptAnchor(ws, anchor)) {
    // Anchors are entry numbers, so find the message that has one rather than counting into
    // the array — the two differ by every compaction entry in the transcript.
    const messages = readSaidSoFar(ws)
    const at = messages.findIndex(message => message.entryNo === anchor.line)
    if (at === -1) return ''
    const from = Math.max(0, at - neighbours)
    return messages.slice(from, at + neighbours + 1)
      .map(message => (message.role ? `${message.role}: ${said(message)}` : said(message)))
      .filter(Boolean).join('\n').trim()
  }

  const full = resolve(ws, anchor.path)
  if (!existsSync(full)) return ''
  const lines = readFileSync(full, 'utf8').split('\n')
  let start = anchor.line - 1
  while (start > 0 && !/^#{1,6}\s/.test(lines[start])) start--
  let end = anchor.line
  while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end++
  return lines.slice(start, end).join('\n').trim()
}
