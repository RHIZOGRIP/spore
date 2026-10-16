/**
 * What a conversation is told of a turn. While it works: what kind of call ran — reading a file,
 * running a command, asking a source by the name its host gave it — and never what it was given or
 * what came back, since a chat message leaves the machine and a command line or a path is the
 * operator's. A conversation whose routing says `details` is shown the command or the path as
 * well. The answer and the stop reason cross in full — except to a `brief` conversation, which is
 * told the spore's state and its answers and nothing of how it runs: no model, spend or limits,
 * and no stop reason, which stays in the service's log.
 */

import { durationText } from '../core/job.js'
import { runningLines } from '../core/limits.js'
import { RUNNING } from '../core/state.js'
import { show } from '../library/verbs.js'

const PLAIN_ENDINGS = new Set(['answer', 'question'])

const LONGEST = 70
const SLOW_MS = 5000

// Spore's own programs, by the variable an agent runs them through, and what each is called.
const PROGRAMS = [
  [/^node\s+"?\$SPORE_SOURCE"?\s*/, 'source '],
  [/^node\s+"?\$SPORE_FANOUT"?\s*/, 'fanout '],
  [/^"?\$SPORE_BROWSER"?\s*/, 'browser '],
  [/^"?\$SPORE_BRAVE"?\s*/, 'search '],
  [/^"?\$SPORE_SPAWN"?\s*/, 'spawn '],
  [/^"?\$SPORE_SQL"?\s*/, 'sql ']
]

const firstLine = (text) => String(text ?? '').split('\n')[0].replace(/\s+/g, ' ').trim()
const cut = (text) => (text.length > LONGEST ? `${text.slice(0, LONGEST - 1)}…` : text)

function kind (line) {
  const source = /^node\s+"?\$SPORE_SOURCE"?\s+([\w.-]+)/.exec(line)
  if (source) return `asking ${source[1]}`
  if (/^"?\$SPORE_BROWSER/.test(line)) return 'using the browser'
  if (/^"?\$SPORE_BRAVE/.test(line)) return 'searching the web'
  if (/^(node\s+"?\$SPORE_FANOUT|"?\$SPORE_SPAWN)/.test(line)) return 'starting sub-agents'
  if (/^"?\$SPORE_SQL/.test(line)) return 'reading its records'
  return 'running a command'
}

function command (text) {
  const line = firstLine(text)
  const plain = kind(line)
  const program = PROGRAMS.find(([pattern]) => pattern.test(line))
  const detailed = program ? cut(line.replace(program[0], program[1]).trim()) : `running ${cut(line)}`
  return { plain, detailed }
}

/** A call as a conversation is told it, plainly and in detail, or null for one it has no use for. */
export function describe (event) {
  const { name, args = {} } = event
  const file = (verb, noun) => ({ plain: `${verb} a ${noun}`, detailed: `${verb} ${cut(firstLine(args.path))}` })
  if (name === 'read') return file('reading', 'file')
  if (name === 'write') return file('writing', 'file')
  if (name === 'edit') return file('editing', 'file')
  if (name === 'exec' || name === 'wsexec') return command(args.command)
  if (name === 'ask' || name === 'quiet') return null
  return { plain: name, detailed: name }
}

/**
 * A turn's events folded into what a conversation is shown: a call when it starts, its time once
 * it ends slow, and that it failed. Returns whether anything changed.
 */
export function track (items, event) {
  if (event.event === 'tool_start') {
    const told = describe(event)
    if (!told) return false
    items.push({ callId: event.callId, ...told })
    return true
  }
  if (event.event === 'tool_end') {
    const item = items.find(i => i.callId === event.callId)
    if (!item) return false
    item.durationMs = event.durationMs
    item.exit = event.outcome === 'exit' ? event.exit : null
    item.failed = event.outcome === undefined ? Boolean(event.error) : !['ok', 'exit'].includes(event.outcome)
    return item.failed || item.exit !== null || item.durationMs >= SLOW_MS
  }
  const note = (text, brief = text) => {
    items.push({ plain: text, detailed: text, brief })
    return true
  }
  if (event.event === 'wrap') return note(`wrapping up — reached its ${event.dimension} limit`, 'wrapping up')
  if (event.event === 'interject') return note('heard you')
  return false
}

/** The lines a conversation sees, the last few, a run of the same call counted rather than repeated. */
export function render (items, { detailed = false, brief = false, last = 6 } = {}) {
  const lines = []
  for (const item of items) {
    const text = (detailed ? item.detailed : brief ? item.brief ?? item.plain : item.plain) +
      (item.failed ? ' — failed' : '') +
      (item.exit != null ? ` — exit ${item.exit}` : '') +
      (item.durationMs >= SLOW_MS ? ` — ${Math.round(item.durationMs / 1000)} s` : '')
    const previous = lines.at(-1)
    if (previous?.text === text) previous.count++
    else lines.push({ text, count: 1 })
  }
  return lines.slice(-last).map(({ text, count }) => `· ${text}${count > 1 ? ` ×${count}` : ''}`)
}

const ending = (record) => [record.stopReason, record.error].filter(Boolean).join(' · ')

/** How the turn ended, where a conversation is told it beside the answer — null for an answer, a question or quiet. */
export const endingOf = (record) => PLAIN_ENDINGS.has(record.stopReason) || record.stopReason === 'quiet' ? null : ending(record)

export function reply ({ record }, { brief = false } = {}) {
  const { output } = record
  if (output) return PLAIN_ENDINGS.has(record.stopReason) || brief ? output : `${output}\n\n— ${ending(record)}`
  if (record.stopReason === 'quiet') return 'nothing to say'
  return brief ? 'no answer this time' : `no answer · ${ending(record)}`
}

/** What a conversation is told of a turn that answered `asked`, none of it said there: who said it, then the answer. */
export function announce ({ record, asked }, { brief = false } = {}) {
  const named = (field) => [...new Set(asked.filter(entry => entry[field]).map(entry => `"${entry[field]}"`))]
  const origins = [
    named('schedule').length ? `schedule ${named('schedule').join(', ')}` : null,
    named('hook').length ? `webhook ${named('hook').join(', ')}` : null,
    named('job').length ? `job ${named('job').join(', ')}` : null
  ].filter(Boolean)
  return `${origins.length ? origins.join(' · ') : 'sent from elsewhere'}\n\n${reply({ record }, { brief })}`
}

/** A turn ended without reading this conversation's message, and nothing is running to read it. */
export function waiting ({ record }, { brief = false } = {}) {
  return `no answer yet${brief ? '' : ` · ${ending(record)}`} — your message waits for the next turn`
}

export const leftOut = (more) => `and ${more} more file${more === 1 ? '' : 's'} in data/out/, in the spore's workspace`

export const unpassed = (count, spores) => `only text reaches a spore for now: your ${count === 1 ? 'file' : `${count} files`} did not reach ${spores.join(' or ')}`

const FENCE = /^ {0,3}(`{3,}|~{3,})/

const closes = (fence, line) => {
  const marker = line.trim()
  return marker.length >= fence.close.length && marker === fence.close[0].repeat(marker.length)
}

/**
 * `text` in pieces of at most `limit`, cut at a line. A piece that ends inside a code block closes
 * it, and the next opens it again with its language, so each piece renders on its own; a line
 * longer than a piece is cut where it must be.
 */
export function pieces (text, limit) {
  if (!String(text)) return []
  const out = []
  let piece = null
  let fence = null
  const flush = () => {
    if (fence) {
      out.push(`${piece}\n${fence.close}`)
      piece = fence.open
    } else {
      out.push(piece)
      piece = null
    }
  }
  for (const line of String(text).split('\n')) {
    const marker = FENCE.exec(line)
    const after = fence ? (closes(fence, line) ? null : fence) : marker ? { open: line, close: marker[1] } : null
    const room = limit - (after ? after.close.length + 1 : 0)
    let rest = line
    for (;;) {
      const joined = piece === null ? rest : `${piece}\n${rest}`
      if (joined.length <= room) {
        piece = joined
        break
      }
      if (piece !== null && piece !== fence?.open) {
        flush()
        continue
      }
      const head = piece === null ? '' : `${piece}\n`
      const take = Math.max(1, room - head.length)
      piece = head + rest.slice(0, take)
      rest = rest.slice(take)
      flush()
    }
    fence = after
  }
  if (piece !== null) out.push(piece)
  return out
}

const waitingText = (n) => `${n} message${n === 1 ? '' : 's'} waiting`

export function statusText (ws, configFile, { brief = false } = {}) {
  const one = show({ ws, configFile })
  if (brief) {
    const running = one.state === RUNNING
    return [
      running ? 'working' : one.paused ? 'paused' : 'idle',
      running && one.paused ? 'paused' : null,
      one.waiting ? waitingText(one.waiting) : null
    ].filter(Boolean).join(' · ')
  }
  return [
    `${one.name} · ${one.model}`,
    `${one.state}${one.draining ? ', finishing' : ''} · ${one.lastTurnNo} turns · ${one.billing !== null && one.billing.kind !== 'metered' ? `not metered · ${one.billing.label}` : `$${one.treeUsd.toFixed(4)}`}`,
    ...(one.turnLimits ? runningLines(one.turnLimits, one.extend) : []),
    one.last ? `last: ${[one.last.stopReason, one.last.error].filter(Boolean).join(' · ')}` : null,
    one.waiting ? `${one.waiting} waiting` : null,
    one.paused ? `paused${one.paused.at ? ` since ${one.paused.at}` : ''}${one.paused.why ? ` (${one.paused.why})` : ''}` : null,
    one.held.length ? `${one.held.length} routed to wait` : null,
    ...one.jobs.running.map(job => `job ${job.name}: ${durationText(Date.now() - Date.parse(job.startedAt))} of ${durationText(job.wallMs)}${job.progress ? ` · ${job.progress}` : ''}`)
  ].filter(Boolean).join('\n')
}
