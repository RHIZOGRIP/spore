/**
 * Event emitter — thin bridge between agent core and harness.
 *
 * Core emits:
 *   round             { index }
 *   tool_start        { name, args, callId }
 *   tool_end          { name, callId, durationMs, error, outcome, result } — outcome: ok, exit (+ exit),
 *                     refused, killed (+ killed: deadline|idle), signal (+ signal) or spawn
 *   tool_block        { name, reason }        — a call not run: the turn ended, or was stopped
 *   stream            { kind, delta }
 *   heartbeat         { phase, elapsedMs }
 *   usage             { … }
 *   compaction_started { messages, kept, estimated, sent, budget } — before the first round
 *   estimate_drift    { round, model, estimated, sent } — once a turn, the provider counted far more
 *   empty_completion  { round, retry }
 *   recovery          { action, reason, attempt, delay }
 *   wrap              { dimension, … }        — a soft bound crossed; the turn wraps
 *   mohdel_idle       { sinceMs }
 *   complete          { output, usage, rounds, stopReason }
 *
 * Harness subscribes to what it needs. Nothing here is a request: the core does not
 * wait on a listener, and there is no event a harness answers.
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

  // Whether anything is listening for a kind. Streaming costs a provider a different
  // call shape and a brokered run refuses it outright, so the loop asks before requesting
  // deltas rather than inferring the want from an emitter merely existing.
  const has = (type) => Boolean(listeners.get(type)?.length)

  return { on, emit, has }
}
