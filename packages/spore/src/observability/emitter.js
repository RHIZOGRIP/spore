/**
 * What the loop and runSpore emit, to the event log and any other listener. The names are
 * `EVENTS` in event-log.js; their payloads, INTEGRATION.md §The event schema. Nothing here is a
 * request: the core does not wait on a listener, and there is no event a listener answers.
 */

export function createEmitter () {
  const listeners = new Map()

  function on (type, fn) {
    if (!listeners.has(type)) listeners.set(type, [])
    listeners.get(type).push(fn)
  }

  function emit (type, data) {
    const fns = listeners.get(type)
    if (fns) for (const fn of fns) fn(data)
  }

  return { on, emit }
}
