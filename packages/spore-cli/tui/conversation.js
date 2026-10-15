/**
 * A spore's conversation as the terminal shows it: what was said to it and where from, what
 * it answered, and how each turn ended — read from its records — and the running turn as its
 * events arrive. Pure: records and events in, items out.
 */

import { printable } from './printable.js'

/** Who said an entry, when that is known: a person by name, or the schedule, webhook or job. */
export function saidBy (entry) {
  if (entry.fromName) return printable(entry.fromName)
  if (entry.schedule) return `schedule "${entry.schedule}"`
  if (entry.hook) return `webhook "${entry.hook}"`
  if (entry.job) return `job "${entry.job}"`
  return null
}

export function originOf (entry) {
  const kind = entry.replyTo?.split(':')[0]
  if (entry.fromName) return kind ? `${saidBy(entry)} · ${kind}` : saidBy(entry)
  return saidBy(entry) ?? kind ?? 'elsewhere'
}

export function saidText (entry) {
  const text = entry.text ?? (entry.bodyPath ? `${entry.bodyHead}…` : '')
  const files = (entry.files ?? []).map(file => `[${file.name}]`)
  return printable([text, ...files].filter(Boolean).join(' '))
}

const said = (entry) => ({ kind: 'said', inboxNo: entry.inboxNo, origin: originOf(entry), text: saidText(entry), at: entry.at })

/** The finished turns, then what no turn has read yet. */
export function history ({ turns, inbox }) {
  const items = []
  for (const turn of turns) {
    for (const entry of inbox.filter(e => e.inboxNo > turn.inboxFrom && e.inboxNo <= turn.inboxTo && !e.setAside && !e.overheard)) items.push(said(entry))
    if (turn.output) items.push({ kind: 'answer', text: printable(turn.output) })
    items.push({
      kind: 'end',
      turnNo: turn.turnNo,
      stopReason: turn.stopReason,
      error: turn.error,
      detail: turn.detail ?? null,
      rounds: turn.rounds,
      treeUsd: turn.treeUsd,
      durationMs: turn.startedAt && turn.endedAt ? Date.parse(turn.endedAt) - Date.parse(turn.startedAt) : null
    })
  }
  for (const entry of inbox.filter(e => !e.consumed && !e.setAside && !e.overheard)) items.push({ ...said(entry), waiting: true })
  return items
}

export const createLive = () => ({ text: '', notes: [], tools: [], rounds: 0, input: null, cached: 0, cost: 0, complete: null })

/** The running turn from its events so far, or null when there are none: a turn's end is recorded before its lock is let go. */
export function liveOf (events) {
  if (!events.length) return null
  const live = createLive()
  for (const event of events) applyEvent(live, event)
  return live
}

/** False when the event changes nothing shown. Text written before a tool call is a note: the answer is what comes last. */
export function applyEvent (live, event) {
  switch (event.event) {
    case 'round':
      live.rounds = event.index + 1
      return true
    case 'stream':
      if (event.kind !== 'message') return false
      live.text += event.delta
      return true
    case 'tool_start':
      if (live.text.trim()) live.notes.push({ kind: 'thought', text: printable(live.text.trim()) })
      live.text = ''
      live.tools.push({ callId: event.callId, name: event.name, args: event.args ?? {}, done: false })
      return true
    case 'tool_end': {
      const tool = live.tools.find(t => t.callId === event.callId)
      if (!tool) return false
      Object.assign(tool, {
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
      return true
    case 'wrap':
      live.notes.push({ kind: 'note', text: `wrapping up — reached its ${event.dimension} limit` })
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
      live.complete = { stopReason: event.stopReason ?? 'answer', output: event.output == null ? null : printable(event.output) }
      if (live.complete.output) live.text = live.complete.output
      return true
    default:
      return false
  }
}

/**
 * What a call's line starts with: whether it worked, the exit code of a command that ran to its
 * end and said no, or how it failed. A tool_end a runtime before outcomes recorded has only `error`.
 */
export function markOf (tool) {
  if (!tool.done) return { text: '…', tone: 'running' }
  if (tool.outcome === undefined) return tool.error ? { text: '✗', tone: 'failed' } : { text: '✓', tone: 'ok' }
  if (tool.outcome === 'ok') return { text: '✓', tone: 'ok' }
  if (tool.outcome === 'exit') return { text: String(tool.exit), tone: 'exit' }
  return { text: `✗ ${tool.killed ?? tool.signal ?? tool.outcome}`, tone: 'failed' }
}
