/**
 * A spore's conversation as the terminal shows it: what was said to it and where from, what
 * it answered, and how each turn ended — read from its records — and the running turn as its
 * events arrive. Pure: records and events in, items out.
 */

import { printable } from './printable.js'

export function originOf (entry) {
  if (entry.schedule) return `schedule "${entry.schedule}"`
  if (entry.hook) return `webhook "${entry.hook}"`
  if (entry.job) return `job "${entry.job}"`
  if (entry.replyTo) return entry.replyTo.split(':')[0]
  return 'elsewhere'
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
    for (const entry of inbox.filter(e => e.inboxNo > turn.inboxFrom && e.inboxNo <= turn.inboxTo)) items.push(said(entry))
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
  for (const entry of inbox.filter(e => !e.consumed)) items.push({ ...said(entry), waiting: true })
  return items
}

export const createLive = () => ({ text: '', notes: [], tools: [], rounds: 0, input: null, cost: 0, complete: null })

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
      Object.assign(tool, { done: true, durationMs: event.durationMs, error: Boolean(event.error) })
      return true
    }
    case 'usage':
      live.input = event.input
      live.cost += event.cost
      return true
    case 'interject':
      live.notes.push({ kind: 'note', text: 'a message arrived mid-turn' })
      return true
    case 'wrap':
      live.notes.push({ kind: 'note', text: `wrapping up — reached its ${event.dimension} limit` })
      return true
    case 'compaction':
      live.notes.push({ kind: 'note', text: 'earlier turns summarized' })
      return true
    case 'complete':
      live.complete = { stopReason: event.stopReason ?? 'answer', output: event.output == null ? null : printable(event.output) }
      if (live.complete.output) live.text = live.complete.output
      return true
    default:
      return false
  }
}
