/**
 * A running turn as a person is shown it: one value folded from its events, which every surface
 * renders — the default rendering below for a chat, `spore send` and the API, a layout of its own
 * for the terminal or an embedder. Contract: ARCHITECTURE.md, "What a running turn shows".
 */

import { describeCall } from '../core/call-table.js'
import { durationText } from '../core/units.js'
import { appendAnnotation, readEvents, runningLimits, storable } from '../core/spore-dir.js'
import { RUNNING, stateOf } from '../core/state.js'
import { SporeError } from '../observability/errors.js'

const HEADLINE_MAX = 200
const SLOW_MS = 5000
const TERMINAL = new Set(['ask', 'quiet'])

export const createLive = ({ startedAt = null } = {}) => ({
  startedAt,
  rounds: 0,
  text: '',
  commentary: '',
  summary: '',
  notes: [],
  headline: null,
  calls: [],
  wrapping: null,
  heard: false,
  annotation: null,
  input: null,
  cached: 0,
  cost: 0,
  complete: null
})

const lastParagraph = (text) => text.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean).at(-1) ?? ''

const headed = (live, text, source) => {
  if (!text) return false
  live.headline = { text, source }
  return true
}

const describedOf = (event) => event.title === undefined
  // A turn its spore was upgraded under wrote `tool_start` without a description.
  ? describeCall(event.name, event.args)
  : { title: event.title, category: event.category, detail: event.detail }

/**
 * False when the event changes nothing a surface shows. The headline is, within a round, what the
 * model wrote for the person, else the last paragraph of its reasoning summary, else text it wrote
 * before a call — the answer is what comes last, never a headline.
 */
export function applyEvent (live, event) {
  switch (event.event) {
    case 'round':
      live.rounds = event.index + 1
      live.commentary = ''
      live.summary = ''
      return true
    case 'stream':
      if (event.kind === 'message') {
        live.text += event.delta
        return true
      }
      if (event.kind === 'commentary') {
        live.commentary += event.delta
        return headed(live, lastParagraph(live.commentary), 'commentary')
      }
      if (event.kind === 'reasoning_summary') {
        live.summary += event.delta
        return !live.commentary.trim() && headed(live, lastParagraph(live.summary), 'reasoning_summary')
      }
      return false
    case 'tool_start': {
      const note = live.text.trim()
      if (note) {
        live.notes.push({ kind: 'thought', text: note })
        if (!live.commentary.trim() && !live.summary.trim()) live.headline = { text: note, source: 'message' }
      }
      live.text = ''
      live.heard = false
      live.calls.push({ callId: event.callId, name: event.name, args: event.args ?? {}, ...describedOf(event), done: false })
      return true
    }
    case 'tool_end': {
      const call = live.calls.find(c => c.callId === event.callId)
      if (!call) return false
      Object.assign(call, {
        done: true,
        durationMs: event.durationMs,
        error: Boolean(event.error),
        outcome: event.outcome,
        exit: event.exit,
        killed: event.killed,
        signal: event.signal
      })
      return true
    }
    case 'annotation':
      live.annotation = event.text
      return true
    case 'usage':
      live.input = event.input + event.cacheRead + event.cacheWrite
      live.cached = event.cacheRead
      live.cost += event.cost
      return true
    case 'interject':
      live.notes.push({ kind: 'note', text: 'a message arrived mid-turn' })
      live.heard = true
      return true
    case 'wrap':
      live.notes.push({ kind: 'note', text: `wrapping up — reached its ${event.dimension} limit` })
      live.wrapping = { dimension: event.dimension }
      return true
    case 'unwrap':
      live.notes.push({ kind: 'note', text: `its ${event.dimension} limit was raised — carrying on` })
      live.wrapping = null
      return true
    case 'compaction_started':
      live.notes.push({ kind: 'note', text: `summarizing ${event.messages} earlier messages before the first round…` })
      return true
    case 'compaction':
      live.notes.push({ kind: 'note', text: 'earlier turns summarized' })
      return true
    case 'compaction_failed':
      live.notes.push({ kind: 'note', text: `earlier turns are over their bound and were not summarized — ${event.why}` })
      return true
    case 'complete':
      live.complete = { stopReason: event.stopReason ?? 'answer', output: event.output ?? null }
      if (live.complete.output) live.text = live.complete.output
      return true
    default:
      return false
  }
}

/** The running turn from its events so far, or null before it has any. */
export function liveOf (events, options) {
  if (!events.length) return null
  const live = createLive(options)
  for (const event of events) applyEvent(live, event)
  return live
}

/**
 * The turn `ws` is running, from its events since the last turn ended and timed from its own start,
 * with the `seq` of the last event read for a caller following on; null when nothing runs.
 */
export function liveIn (ws) {
  if (stateOf(ws).state !== RUNNING) return null
  const ended = readEvents(ws, { event: 'turn_end' }).at(-1)?.seq ?? 0
  const events = readEvents(ws, { after: ended })
  const live = createLive({ startedAt: runningLimits(ws)?.startedAt ?? null })
  for (const event of events) applyEvent(live, event)
  return { live, seq: events.at(-1)?.seq ?? ended }
}

/**
 * A line of the embedder's own — an estimate, a place in a queue — shown under the running turn's
 * header on every surface until `null` takes it away or the turn ends. `{ seq }`, or
 * `{ refused: 'idle' }` when nothing runs.
 */
export function annotateTurn (ws, text) {
  if (text !== null && !(typeof text === 'string' && text.trim() !== '' && text.length <= HEADLINE_MAX)) {
    throw new SporeError('an annotation is a line of text, or null to take it away', {
      type: 'ANNOTATION_INVALID',
      detail: `got ${typeof text === 'string' ? `${text.length} characters` : JSON.stringify(text)}, expected 1 to ${HEADLINE_MAX}`
    })
  }
  return appendAnnotation(ws, text === null ? null : storable(text))
}

const oneLine = (text) => Array.from(text, c => (c < ' ' || c === '\u007f' ? ' ' : c)).join('').replace(/\s+/g, ' ').trim()

function cut (text, max) {
  if (text.length <= max) return text
  const kept = text.slice(0, max - 1)
  const space = kept.lastIndexOf(' ')
  return `${(space > max / 2 ? kept.slice(0, space) : kept).trimEnd()}…`
}

const ending = (call) =>
  !call.done
    ? ''
    : call.outcome === 'exit'
      ? ` — exit ${call.exit}`
      : (call.outcome === undefined ? call.error : call.outcome !== 'ok')
          ? ' — failed'
          : call.durationMs >= SLOW_MS ? ` — ${Math.round(call.durationMs / 1000)} s` : ''

/**
 * The default rendering: what the turn is doing, in a few lines of plain text. `brief` is the
 * model's note, the current call by its title, how many calls ran and for how long; `plain` adds how
 * the current call ended and why the turn is wrapping up; `details` shows the call's path or
 * command line. No bound, no count against a total and no spend — the terminal's own layout shows
 * those.
 */
export function renderLive (live, { level = 'plain', now = Date.now() } = {}) {
  const calls = live.calls.filter(call => !TERMINAL.has(call.name))
  const elapsed = live.startedAt === null ? 0 : now - Date.parse(live.startedAt)
  const header = [
    'working…',
    calls.length ? `${calls.length} call${calls.length === 1 ? '' : 's'}` : null,
    elapsed >= 60_000 ? durationText(elapsed) : null
  ].filter(Boolean).join(' · ')
  const lines = [header]
  if (live.annotation) lines.push(cut(oneLine(live.annotation), HEADLINE_MAX))
  if (live.headline) lines.push(cut(oneLine(live.headline.text), HEADLINE_MAX))
  const current = calls.at(-1)
  if (current) lines.push(`· ${level === 'details' ? current.detail : current.title}${level === 'brief' ? '' : ending(current)}`)
  if (live.wrapping) lines.push(level === 'brief' ? 'wrapping up' : `wrapping up — reached its ${live.wrapping.dimension} limit`)
  else if (live.heard) lines.push('heard you')
  return lines
}
