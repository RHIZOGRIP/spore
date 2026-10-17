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
