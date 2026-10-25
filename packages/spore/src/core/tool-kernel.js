/**
 * Tool execution kernel — scheduling, abort, timing.
 *
 * No knowledge of specific tools, the loop, models, or context budgets. A tool returns a
 * call record (`recorded`), whose exit code says whether the call worked; a refusal
 * (`refusal.js`); or text. The first two reach the model as text and everything else as a
 * mark, so nothing reads a status out of text. A result the model has to *see* carries
 * `images` beside it — `{ record, images }` — which become parts
 * so they replay with the transcript rather than attaching to one call.
 */

import { isRecorded, readOutcome } from './call-record.js'
import { RECORD, REFUSED, mark } from './marks.js'
import { isRefusal, refuse, refusalText, refusedResult } from './refusal.js'
import { silent } from '../observability/logger.js'

const noEmit = { emit () {}, on () {} }
const noDescription = () => ({})

const resultOf = (raw) => {
  if (isRefusal(raw)) return { text: refusalText(raw), images: [], refused: true, record: false }
  if (isRecorded(raw)) return { text: JSON.stringify(raw.record), images: raw.images ?? [], refused: false, record: true }
  return { text: String(raw), images: [], refused: false, record: false }
}

const toolMessage = (tc, { text, images, refused, record }) => {
  const message = {
    role: 'tool',
    toolCallId: tc.id,
    toolName: tc.name,
    content: images.length
      ? [{ type: 'text', text }, ...images.map(i => ({ type: 'image', fileUri: i.fileUri, mimeType: i.mimeType }))]
      : text
  }
  if (refused) mark(message, REFUSED)
  if (record) mark(message, RECORD)
  return message
}

// A non-zero exit is the command's own verdict and may be a "no", unlike a call that did not finish.
const outcomeOf = ({ ok, refused, record }) => {
  if (refused) return { outcome: 'refused' }
  if (ok) return { outcome: 'ok' }
  if (record.spawnError) return { outcome: 'spawn' }
  if (record.killed) return { outcome: 'killed', killed: record.killed }
  if (record.signal) return { outcome: 'signal', signal: record.signal }
  return { outcome: 'exit', exit: record.exit }
}

// Heartbeat interval while a tool is executing — mirrors loop.js's
// model-answer heartbeat, so a caller watching for a stalled turn sees a
// frame every 10s whichever phase the turn is in.
const HEARTBEAT_INTERVAL_MS = 10_000

/**
 * Execute a single tool call, timed.
 */
async function executeSingle (tc, { toolFns, describe, emitter, signal, logger }) {
  const fn = toolFns[tc.name]
  const args = tc.arguments
  const start = Date.now()

  // Checked here rather than by each tool: a batch runs its mutators one after another, and a
  // turn stopped during the first must not go on to write with the second.
  if (signal?.aborted) {
    emitter.emit('tool_block', { name: tc.name, reason: 'cancelled' })
    return refusedResult(tc.id, tc.name, 'not run — the turn was stopped before it started')
  }

  emitter.emit('tool_start', { name: tc.name, args, callId: tc.id, ...describe(tc.name, args) })
  logger.debug({ tool: tc.name, args }, '\u2192 tool call')

  // A model naming a tool it does not have used to reach `await fn(...)` on undefined
  // and get back `fn is not a function` — an error about our internals, telling it
  // nothing it could act on. Measured on a cell that called `exec` its precursor had
  // not granted: five identical failures, `soft:progress`, and its whole budget spent
  // on a message that never said the tool did not exist.
  if (typeof fn !== 'function') {
    const available = Object.keys(toolFns).sort()
    emitter.emit('tool_end', { name: tc.name, callId: tc.id, durationMs: 0, error: true, outcome: 'refused', result: 'no such tool' })
    return refusedResult(tc.id, tc.name, `there is no tool called "${tc.name}" here — you have ${available.join(', ') || 'none'}`)
  }

  // A tool can hold the turn for minutes with nothing else emitted, so the heartbeat is
  // what tells a watcher the difference between working and hung.
  const heartbeatTimer = setInterval(() => {
    emitter.emit('heartbeat', { phase: 'tool', tool: tc.name, elapsedMs: Date.now() - start })
  }, HEARTBEAT_INTERVAL_MS)
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()

  let raw
  try {
    raw = await fn(args, { signal })
  } catch (e) {
    raw = refuse(e.message)
  } finally {
    clearInterval(heartbeatTimer)
  }
  const result = resultOf(raw)
  const message = toolMessage(tc, result)

  const durationMs = Date.now() - start
  // What the call contract says happened, not whether the function threw. A command
  // that exited 7 failed, and a console rendering a success marker for it is lying.
  const outcome = readOutcome(message)
  emitter.emit('tool_end', {
    name: tc.name,
    callId: tc.id,
    durationMs,
    error: !outcome.ok,
    ...outcomeOf(outcome),
    result: result.text.slice(0, 200),
    ...(result.images.length ? { images: result.images.length } : {})
  })
  return message
}

/**
 * Execute a batch of tool calls with scheduling, abort, and timing.
 *
 * @param {object} opts
 * @param {Array}  opts.toolCalls   — the tool calls to run
 * @param {object} opts.toolFns     — { name: async (args, { signal }) => string | a call record | a refusal }
 * @param {object} [opts.emitter]   — event emitter
 * @param {Set}    opts.mutators    — tool names that mutate state (serial execution)
 * @param {AbortSignal} [opts.signal] — parent abort signal
 * @param {object} [opts.logger]
 * @returns {Promise<Array<{role, toolCallId, toolName, content}>>}
 */
export async function executeTools ({ toolCalls, toolFns, describe = noDescription, emitter = noEmit, mutators, signal, logger = silent }) {
  if (!toolCalls.length) return []

  const ctx = { toolFns, describe, emitter, signal, logger }

  // Partition into readers (concurrent) and writers (serial)
  const readers = []
  const writers = []
  for (const tc of toolCalls) {
    if (mutators.has(tc.name)) writers.push(tc)
    else readers.push(tc)
  }

  // Build an index map to restore original order
  const resultMap = new Map()

  // Run readers in parallel
  if (readers.length) {
    const readerResults = await Promise.all(readers.map(tc => executeSingle(tc, ctx)))
    for (let i = 0; i < readers.length; i++) {
      resultMap.set(readers[i].id, readerResults[i])
    }
  }

  // Run writers sequentially
  for (const tc of writers) {
    const result = await executeSingle(tc, ctx)
    resultMap.set(tc.id, result)
  }

  // Return in original toolCalls order
  return toolCalls.map(tc => resultMap.get(tc.id))
}
