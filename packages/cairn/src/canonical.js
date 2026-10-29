/**
 * The canonical text of an entry: what `jq -cS` prints for it, so a shell can re-derive every line
 * and its hash with nothing of cairn. Keys sorted by code point (jq compares UTF-8 bytes), no
 * whitespace, integers only, DEL escaped as jq escapes it.
 */

import { CairnError } from './errors.js'

const byCodePoint = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))

function text (value, at) {
  if (!value.isWellFormed()) throw new CairnError(`${at} holds a lone surrogate`, { type: 'shape-mismatch', detail: at })
  return JSON.stringify(value).replaceAll('\u007f', '\\u007f')
}

function write (value, at) {
  if (value === null || value === true || value === false) return String(value)
  if (typeof value === 'string') return text(value, at)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new CairnError(`${at} is ${value}, and a number in an entry is an integer within ±2^53 — a decimal is a string`, { type: 'shape-mismatch', detail: at })
    }
    return Object.is(value, -0) ? '0' : String(value)
  }
  if (Array.isArray(value)) return `[${value.map((item, i) => write(item, `${at}[${i}]`)).join(',')}]`
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value).sort(byCodePoint)
    return `{${keys.map(key => `${text(key, `${at}.${key}`)}:${write(value[key], `${at}.${key}`)}`).join(',')}}`
  }
  throw new CairnError(`${at} is not JSON`, { type: 'shape-mismatch', detail: at })
}

export function canonical (value) {
  return write(value, '$')
}
