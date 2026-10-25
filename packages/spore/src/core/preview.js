/**
 * Both ends of something too long to carry whole.
 *
 * Contract: ARCHITECTURE.md, "The spore command". A preview's job here is to carry the
 * *instruction*, not to
 * sample the content: the two shapes a long message takes put it at opposite ends —
 * `summarise this:` before twenty pages, and forty kilobytes of log before `why does this
 * fail?` — and nothing tells you which you have. A head alone loses the ask in the second,
 * which is the commoner one.
 *
 * Written once because `read` refusing an oversized file wants the same thing, and two
 * implementations would differ on whether they snap to lines.
 */

const EACH = 800

// How far past the cut a line boundary is still worth reaching for. Beyond that the text
// has no lines near the cut — a pasted document rather than a log — and a hard cut reads
// better than a quarter of the budget spent looking for one.
const SLACK = 0.25

const HIGH = (code) => code >= 0xd800 && code <= 0xdbff
const LOW = (code) => code >= 0xdc00 && code <= 0xdfff

// A character outside the BMP is two UTF-16 units, so cutting at a count can land between
// them. The half that survives is a lone surrogate: `JSON.stringify` escapes it and the
// line stays valid, but the character is gone and anything that takes the text through a
// Buffer renders U+FFFD. Cheaper to not cut there.
const whole = (text) => {
  if (HIGH(text.charCodeAt(text.length - 1))) return text.slice(0, -1)
  return text
}
const wholeFromStart = (text) => (LOW(text.charCodeAt(0)) ? text.slice(1) : text)

/** Both ends, and how many **bytes** are between them — the unit the file is measured in. */
export function headAndTail (text) {
  if (text.length <= EACH * 2) return { head: text, tail: '', elided: 0 }

  let head = text.slice(0, EACH)
  const lastBreak = head.lastIndexOf('\n')
  head = lastBreak >= EACH * (1 - SLACK) ? head.slice(0, lastBreak) : whole(head)

  let tail = text.slice(-EACH)
  const firstBreak = tail.indexOf('\n')
  tail = firstBreak !== -1 && firstBreak <= EACH * SLACK ? tail.slice(firstBreak + 1) : wholeFromStart(tail)

  return {
    head,
    tail,
    elided: Buffer.byteLength(text) - Buffer.byteLength(head) - Buffer.byteLength(tail)
  }
}
