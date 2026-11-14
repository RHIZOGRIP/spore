/**
 * What spore knows about a message that the message does not carry.
 *
 * A message is mohdel's wire `Message`, which refuses fields it does not define, so a note
 * of spore's own — this is the wrap notice, this summary stands in for a compacted head — is
 * held here, keyed by the message object, and written beside it in the transcript.
 *
 * So is what a user message was sent with ahead of what was said: `content` stays what the
 * person said, and every request carries the message as it was first sent.
 */

export const WRAP = 'wrap'
export const NUDGE = 'nudge'
export const SCHEDULE_NOTICE = 'schedule-notice'
export const CONTEXT_NOTICE = 'context-notice'
export const COMPACTED = 'compacted'
export const DREAMT = 'dreamt'
export const REFUSED = 'refused'
export const RECORD = 'record'

const held = new WeakMap()

export function mark (message, ...names) {
  const set = held.get(message) ?? new Set()
  for (const name of names) set.add(name)
  held.set(message, set)
  return message
}

export function marked (message, name) {
  return held.get(message)?.has(name) === true
}

export function marksOf (message) {
  return [...(held.get(message) ?? [])]
}

const ahead = new WeakMap()

export function sentWith (message, text) {
  ahead.set(message, text)
  return message
}

export function aheadOf (message) {
  return ahead.get(message) ?? null
}

export function asSent (message) {
  return ahead.has(message) ? { ...message, content: ahead.get(message) + message.content } : message
}
