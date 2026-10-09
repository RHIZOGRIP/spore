/**
 * Many spores, each told what to do, with at most `atOnce` running at a time.
 *
 * An errand is `{ ws, messages, label, id }`: a workspace that already holds its definition, what
 * to say to it — one message at a time, the next once the last has ended — and an `id` the
 * caller keeps stable, which is what makes the batch resumable. Message *i* goes to `send`
 * under the request id `errand:<id>:<i>`, so the inbox says what the errand has sent whatever else
 * the spore was told, and a batch started again after an interruption sends nothing twice. A
 * new batch on the same spore takes new ids. The label is for reports.
 *
 * A message said and never started — the sender interrupted between the append and the
 * start, or refused an admission slot after the append — is sent again under the same request
 * id, which `send` takes as starting a runner for it rather than saying it twice.
 *
 * A message has ended with its own turn: the finished turn that read it, or, when nothing is
 * running, the first finished turn started after it that read nothing — a runner that failed
 * before it got there. What the errand ended with is those turns, never the workspace's latest,
 * which may be anyone's. A runner that died while one of the errand's messages was outstanding
 * ends the errand, as an outcome rather than something to retry; one that died on another
 * sender's turn does not, and the next message starts a runner as `send` always does.
 *
 * Answers `{ stuck, ended }`: the errands that never finished, and `{ errand, turns, crashed? }` for
 * each that did, message *i*'s turn record at `turns[i]`.
 *
 * How many run at once is the caller's to say: it is about the machine and the provider,
 * not about any one spore. A start may be refused when the admission slots are held by
 * other callers; the batch tries again on its next poll.
 */

import { SporeError } from '../observability/errors.js'
import { send } from './send.js'
import { inboxRequest, turnOfMessage } from './spore-dir.js'
import { RUNNING, stateOf } from './state.js'

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

export const requestOf = (errand, i) => `errand:${errand.id}:${i}`

export async function runBatch (errands, { atOnce = 4, deliver = send, env = process.env, pollMs = 2000, deadline = Infinity, now = Date.now, wait = sleep, report = () => {} } = {}) {
  if (!Number.isInteger(atOnce) || atOnce < 1) {
    throw new SporeError(`at once ${atOnce} is not a number of errands`, { type: 'BATCH_USAGE', detail: 'a whole number, at least 1' })
  }
  for (const errand of errands) {
    if (typeof errand.id !== 'string' || !errand.id) {
      throw new SporeError(`errand ${errand.label ?? errand.ws} has no id`, { type: 'BATCH_USAGE', detail: 'each errand carries an id the caller keeps stable, so running the batch again resumes it' })
    }
    if (!Array.isArray(errand.messages) || !errand.messages.length) {
      throw new SporeError(`errand ${errand.label ?? errand.ws} has nothing to say`, { type: 'BATCH_USAGE', detail: 'messages is a list of at least one message' })
    }
  }

  // The messages this call started a runner for, waited on even before that runner has taken
  // the lock. One said and never started is not among them — its sender interrupted after the
  // append, refused a slot after it, or delivered into a turn that was then stopped before
  // reading it — and is started again under its request id once nothing is running.
  const started = new Set()

  // Where an errand stands: the turns its ended messages ended with, and the first message that
  // has not ended — to `start` or `going` — or `finished`, `crashed` when its runner died on it.
  const progress = (errand) => {
    const { state } = stateOf(errand.ws)
    const turns = []
    for (let i = 0; i < errand.messages.length; i++) {
      const entry = inboxRequest(errand.ws, requestOf(errand, i))
      if (!entry) return { turns, next: i, start: true }
      const ended = turnOfMessage(errand.ws, entry)
      if (ended && (ended.read || state !== RUNNING)) {
        turns.push(ended.turn)
        continue
      }
      if (state === 'crashed') return { turns, finished: true, crashed: true }
      if (state !== RUNNING && !started.has(requestOf(errand, i))) return { turns, next: i, start: true }
      return { turns, next: i, going: true }
    }
    return { turns, finished: true }
  }

  const announced = new Set(errands.filter(errand => progress(errand).finished).map(errand => errand.ws))
  for (;;) {
    const where = new Map(errands.map(errand => [errand, progress(errand)]))
    for (const errand of errands) {
      const at = where.get(errand)
      if (announced.has(errand.ws) || !at.finished) continue
      announced.add(errand.ws)
      const last = at.turns.at(-1)
      report({ event: 'ended', errand: errand.label, ...(at.crashed ? { crashed: true } : { turnNo: last.turnNo, stopReason: last.stopReason }) })
    }
    const ended = errands.filter(errand => where.get(errand).finished).map(errand => {
      const { turns, crashed } = where.get(errand)
      return { errand, turns, ...(crashed ? { crashed } : {}) }
    })
    if (ended.length === errands.length) return { stuck: [], ended }
    if (now() >= deadline) return { stuck: errands.filter(errand => !where.get(errand).finished), ended }

    let going = errands.filter(errand => where.get(errand).going).length
    for (const errand of errands) {
      if (going >= atOnce) break
      const { next, start } = where.get(errand)
      if (!start) continue
      try {
        const sent = deliver(errand.ws, errand.messages[next], { env, requestId: requestOf(errand, next) })
        if (sent.started) started.add(requestOf(errand, next))
      } catch (err) {
        if (err.type !== 'ADMISSION_FULL') throw err
        report({ event: 'full', errand: errand.label, message: next })
        break
      }
      report({ event: 'started', errand: errand.label, message: next })
      going++
    }
    await wait(pollMs)
  }
}
