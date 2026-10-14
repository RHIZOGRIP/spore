/**
 * The event log — what a turn did, written where something else can read it.
 *
 * `emitter.js` is the in-process protocol, which only a caller inside the turn can hear. This
 * writes the same events to the workspace's `events` so anything outside the process can
 * follow a turn: a TUI, a relay, a service consuming the stream. Contract and the reason
 * it is a log rather than a socket: ARCHITECTURE.md, "Watching a spore".
 *
 * **These names are an API.** A consumer that is not in this repository reads them, so
 * they never change meaning, fields are only ever added, and an unknown event is ignored
 * rather than refused. `SCHEMA` is the version that promises it.
 */

import { EVENT_SCHEMA, appendEvents } from '../core/spore-dir.js'
import { silent } from './logger.js'

export const SCHEMA = EVENT_SCHEMA

/**
 * Every event the log holds, by name, because an event left out is one a consumer cannot know
 * it is missing. All but the last cross from the agent; `turn_end` is the supervisor's, written
 * in the transaction that makes the turn final, so the agent's log never carries it.
 *
 * **`complete` and `turn_end` are not the same fact, and an implementer picks by what it needs.**
 * `complete` is the agent's account the moment its loop ends: the answer (`output`), fast — some
 * 20 ms before the turn is final, or the whole drain when model calls are still in flight — and
 * right for rendering a reply. The turn record carries the same `output`, and is where a
 * finished turn's answer is read, since retention prunes events. It is not how the turn ended: its `usage` is the loop's own
 * spend, without the cells' or any call settled after it; its `stopReason` can be revised (a
 * wall reached reads `cancelled` here and `hard:wall` in the record); an agent killed after it
 * leaves the runner to say how the turn ended; and a supervisor dying right after it leaves
 * the turn unfinished until the next runner starts. `turn_end` is the record: settled money
 * (`ownUsd`, `treeUsd`, `settled`), the final `stopReason`, `concluded`, `turnNo` and the inbox
 * range it answered — never ahead of the `turns` view and never disagreeing with it, so it is
 * what anything that bills, counts or closes a turn reads.
 */
const CARRIED = [
  'round', 'tool_start', 'tool_end', 'tool_block', 'wrap', 'interject',
  'heartbeat', 'stream', 'usage', 'complete', 'deliverables', 'recall', 'compaction_started', 'compaction', 'compaction_failed',
  'estimate_drift', 'empty_completion', 'recovery'
]

export const EVENTS = [...CARRIED, 'turn_end']

/**
 * Named by the schema and not produced: mohdel's factory never calls an idle handler, so
 * there is nothing to carry. It joins the carried events when mohdel emits it, and every consumer of
 * the log has it without changing.
 */
export const PROMISED = ['mohdel_idle']

// Streamed text is the one event that arrives in hundreds. The log is a client of it like
// any other, so it batches its own lines — one per burst of one kind — and what the emitter
// delivers to everything else is untouched. The window is how far behind the model a
// consumer following the log reads a reply, and a reply rendered as it streams is followed
// from here: short enough for that, long enough that a long stretch of reasoning is still
// at most ten lines a second rather than one per chunk.
const STREAM_FLUSH_MS = 100
const STREAM_MAX_CHARS = 4096

/**
 * `tool_start` carries the arguments and `tool_end` two hundred characters of result. On
 * a local console that is what makes it useful; across a network it is a path, a query or
 * a command line leaving the host. The log keeps them — it is the workspace's own record, and
 * the agent could read its own call records anyway — and **a relay is what decides what
 * leaves the machine**, which is why that decision is named here rather than assumed.
 */
export function attachEventLog (emitter, { state, runId, logger = silent }) {
  // Numbered by the supervisor, which holds the workspace's count.
  const write = (event, data) => {
    try {
      appendEvents(state, [{
        v: SCHEMA,
        at: new Date().toISOString(),
        runId,
        event,
        ...data
      }])
    } catch (err) {
      // A turn is not worth failing over a log nobody is reading yet.
      logger.warn({ event, err: err.message }, '[events] could not append')
    }
  }
  let pending = null
  const flush = () => {
    if (!pending) return
    clearTimeout(pending.timer)
    const { kind, delta } = pending
    pending = null
    write('stream', { kind, delta })
  }
  emitter.on('stream', ({ kind, delta }) => {
    if (pending && pending.kind !== kind) flush()
    if (!pending) pending = { kind, delta: '', timer: setTimeout(flush, STREAM_FLUSH_MS) }
    pending.delta += delta
    if (pending.delta.length >= STREAM_MAX_CHARS) flush()
  })
  // Anything else is written after what was streamed before it, so the log stays in order.
  for (const event of CARRIED.filter(e => e !== 'stream')) {
    emitter.on(event, (data) => {
      flush()
      write(event, data ?? {})
    })
  }
  return { flush }
}
