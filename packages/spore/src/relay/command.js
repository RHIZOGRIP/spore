/** The commands the relay obeys in a conversation; any other it answers with the help. */
export const VERBS = new Set(['status', 'stop', 'wrap', 'extend', 'flush', 'help'])

const COMMAND = /^\/([a-z]+)(?:\s+(.+))?$/is

/** `{ verb, args }` for a message written as `/<verb> [args]`, or null for any other. */
export function commandOf (text) {
  const found = text?.match(COMMAND)
  return found ? { verb: found[1].toLowerCase(), args: found[2] ?? '' } : null
}
