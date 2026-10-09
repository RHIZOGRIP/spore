/**
 * The one reading of a message's text.
 *
 * Contract: ARCHITECTURE.md, "The model broker".
 *
 * `content` is a string or mohdel's part array, and every consumer that wanted characters
 * was written when only the string existed. A part array answers `.length` with a part
 * count, `.trim()` with a TypeError, and `===` with reference identity — so each of those
 * fails differently and two of them fail silently.
 */

export function textOf (message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') text += part.text
  }
  return text
}
