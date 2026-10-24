/**
 * What a conversation is told of a turn. While it works, the default rendering of `live`
 * (`library/live.js`): what kind of call ran — reading a file, running a command, asking a source by
 * the name its host gave it — and never what it was given or what came back, since a chat message
 * leaves the machine and a command line or a path is the operator's. A conversation whose routing
 * says `details` is shown the command or the path as well. The answer and the stop reason cross in
 * full — except to a `brief` conversation, which is told the spore's state and its answers and
 * nothing of how it runs: no model, spend or limits, and no stop reason, which stays in the
 * service's log.
 */

import { durationText } from '../core/units.js'
import { runningLines } from '../core/limits.js'
import { originLabel } from '../core/spore-dir.js'
import { RUNNING } from '../core/state.js'
import { show } from '../library/verbs.js'

const PLAIN_ENDINGS = new Set(['answer', 'question'])

/** `text` with `&`, `<` and `>` as entities, which HTML and Slack's mrkdwn both take literally. */
export const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const ending = (record) => [record.stopReason, record.error].filter(Boolean).join(' · ')

/** How the turn ended, where a conversation is told it beside the answer — null for an answer, a question or quiet. */
export const endingOf = (record) => PLAIN_ENDINGS.has(record.stopReason) || record.stopReason === 'quiet' ? null : ending(record)

export function reply ({ record }, { brief = false } = {}) {
  const { output } = record
  if (output) return PLAIN_ENDINGS.has(record.stopReason) || brief ? output : `${output}\n\n— ${ending(record)}`
  if (record.stopReason === 'quiet') return 'nothing to say'
  return brief ? 'no answer this time' : `no answer · ${ending(record)}`
}

/** What said the messages `asked` when nobody in the conversation did: `schedule "digest"`, `webhook "forge"`… */
export function originOf (asked) {
  const origins = [...new Set(asked.map(originLabel).filter(Boolean))]
  return origins.length ? origins.join(' · ') : 'sent from elsewhere'
}

/**
 * What a conversation is told of a turn that answered `asked`, none of it said there: what said
 * it, then the answer — and the answer alone in a brief conversation, where what said it is how
 * the spore runs.
 */
export function announce ({ record, asked }, { brief = false } = {}) {
  return brief ? reply({ record }, { brief }) : `${originOf(asked)}\n\n${reply({ record })}`
}

/** A turn ended without reading this conversation's message, and nothing is running to read it. */
export function waiting ({ record }, { brief = false } = {}) {
  return `no answer yet${brief ? '' : ` · ${ending(record)}`} — your message waits for the next turn`
}

export const leftOut = (more) => `and ${more} more file${more === 1 ? '' : 's'} in data/out/, in the spore's workspace`

/** A size as a person reads it: whole kilobytes under a megabyte, whole megabytes from there. */

/** What a person is told of the files that did not reach the spore, a line each with why. */
export const notCome = (files) => files.map(file => `${file.name} did not reach the spore: ${file.missing}`).join('\n')

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
