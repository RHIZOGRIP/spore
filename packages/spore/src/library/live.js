/**
 * A running turn as a person is shown it: one value folded from its events, which every surface
 * renders — the default rendering below for a chat, `spore send` and the API, a layout of its own
 * for the terminal or an embedder. Contract: ARCHITECTURE.md, "What a running turn shows".
 */

import { describeCall } from '../core/call-table.js'
import { durationText } from '../core/job.js'

const HEADLINE_MAX = 200
const SLOW_MS = 5000
const TERMINAL = new Set(['ask', 'quiet'])

export const createLive = ({ startedAt = null } = {}) => ({
  startedAt,
  rounds: 0,
  text: '',
  notes: [],
  headline: null,
  calls: [],
  wrapping: null,
  heard: false,
  input: null,
  cached: 0,
  cost: 0,
  complete: null
})

const describedOf = (event) => event.title === undefined
  // A turn its spore was upgraded under wrote `tool_start` without a description.
  ? describeCall(event.name, event.args)
  : { title: event.title, category: event.category, detail: event.detail }

/** False when the event changes nothing a surface shows. Text written before a call is the model's note on it; the answer is what comes last. */
export function applyEvent (live, event) {
  switch (event.event) {
    case 'round':
      live.rounds = event.index + 1
      return true
    case 'stream':
      if (event.kind !== 'message') return false
      live.text += event.delta
      return true
    case 'tool_start': {
      const note = live.text.trim()
      if (note) {
        live.notes.push({ kind: 'thought', text: note })
        live.headline = { text: note, source: 'message' }
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
  if (live.headline) lines.push(cut(oneLine(live.headline.text), HEADLINE_MAX))
  const current = calls.at(-1)
  if (current) lines.push(`· ${level === 'details' ? current.detail : current.title}${level === 'brief' ? '' : ending(current)}`)
  if (live.wrapping) lines.push(level === 'brief' ? 'wrapping up' : `wrapping up — reached its ${live.wrapping.dimension} limit`)
  else if (live.heard) lines.push('heard you')
  return lines
}
