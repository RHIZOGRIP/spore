/**
 * A chat connector's promises, kept once for every platform: a message reaches its spore once, a
 * finished turn reaches its conversation at least once and never mixed with another's, a restart
 * loses nothing, and nothing fails in silence. The platform is the adapter's — its transport, its
 * API, what it calls a conversation and a person — and the contract between them is
 * `docs/relay.md`.
 *
 * `env` is the environment the service was started with, before `environment` beside
 * `config.json` was read: that file is read again for every turn, so a key added to it reaches the
 * next turn without a restart, and a variable the service was started with still wins.
 */

import { existsSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import { attemptOutbox, changeText, extendTurn, isWorkspace, lastEventSeq, loadEnvironment, outbox, readConfig, RUNNING, send, settleOutbox, stateOf, stop, turnsSince, watchAll, workspaceFor, wrapTurn, CONFIG_FILE, databaseOf } from '../index.js'
import { credentialVariables, routesOf } from './bot-file.js'
import { createDelivery } from './delivery.js'
import { announce, leftOut, pieces, render, reply, statusText, track, unpassed, waiting } from './render.js'
import { loadState, saveState } from './state.js'

const TAKES_ARGUMENTS = new Set(['extend', 'wrap'])
const WORKING = 'working…'
const STILL_WORKING = 'heard you — still working…'
const ANSWERED = 'answered below'
const MAY_REPEAT = '(this may repeat an earlier message)'

const pause = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

const said = (err) => [err.message, err.detail].filter(Boolean).join(' — ')

export function createRelay ({ adapter, botFile, statePath, env, log, configFile = CONFIG_FILE, sleep = pause, editEveryMs = adapter.limits.editEveryMs, followEveryMs = 1000 }) {
  const { kind, noun } = adapter
  const prefix = `${kind}:${basename(botFile, '.json')}/`
  const kept = new Set(adapter.sourceVariables)
  const sendEnv = () => {
    const fresh = { ...env }
    loadEnvironment(configFile, fresh)
    for (const variable of credentialVariables(adapter, configFile)) if (!kept.has(variable)) delete fresh[variable]
    return fresh
  }
  const state = loadState(statePath, adapter)
  const stopping = new AbortController()
  const delivery = createDelivery({ sleep: (ms) => sleep(ms, stopping.signal), signal: stopping.signal })
  const notes = new WeakMap()
  const shown = new Map()
  const limitedUntil = new Map()
  let followed = new Map()
  let detailed = new Set()
  let routeFailure = null

  const save = () => saveState(statePath, state, adapter)
  const noteOf = (entry) => notes.get(entry) ?? Promise.resolve(entry.note)
  const where = (conversation) => `${noun} ${conversation}`

  const route = () => ({ config: readConfig(configFile), table: routesOf(adapter, botFile) })
  const sporeOf = (name, config) => {
    const ws = workspaceFor(name, { config }).path
    return isWorkspace(ws) ? ws : null
  }

  const tell = (conversation, text) => delivery.to(conversation, async (attempt) => {
    for (const part of pieces(text, adapter.limits.message)) await attempt(() => adapter.post(conversation, part))
  }).catch(err => log(`${where(conversation)}: not delivered — ${said(err)}`))

  const change = (conversation, act) => {
    let answer
    try {
      answer = act()
    } catch (err) {
      return tell(conversation, said(err))
    }
    return tell(conversation, changeText(answer))
  }

  const obey = (conversation, ws, verb, args = '') => {
    if (verb === 'stop') return tell(conversation, stop(ws).stopped ? 'stopping it' : 'nothing is running')
    if (verb === 'status') return tell(conversation, statusText(ws, configFile))
    if (verb === 'wrap') return change(conversation, () => wrapTurn(ws, args.trim() || undefined))
    if (verb === 'extend') {
      const [dimension, amount] = args.trim().split(/\s+/)
      if (!dimension) return tell(conversation, adapter.usage.extend)
      return change(conversation, () => extendTurn(ws, dimension, amount))
    }
    return tell(conversation, adapter.usage.help)
  }

  const follows = (ws) => {
    if (state.cursors[ws]) return false
    state.cursors[ws] = { seq: lastEventSeq(ws), turn: stateOf(ws).lastTurnNo, database: databaseOf(ws) }
    return true
  }

  const pass = (message, name, ws) => {
    const { conversation } = message
    if (follows(ws)) save()
    let sent
    try {
      sent = send(ws, message.text, {
        requestId: `${kind}:${message.id}${message.addresses ? `:${name}` : ''}`,
        replyTo: `${prefix}${conversation}`,
        from: { name: message.person.name, id: `${kind}:${message.person.id}`, where: message.where },
        env: sendEnv()
      })
    } catch (err) {
      log(`${where(conversation)}: send to ${name} refused — ${err.type} ${said(err)}`)
      return tell(conversation, err.type === 'ADMISSION_FULL' ? `busy — ${said(err)}` : `not delivered — ${said(err)}`)
    }
    if (sent.repeated) return log(`${where(conversation)}: message ${message.id} was already said to ${name}, as inbox ${sent.inbox}`)

    const entry = { inbox: sent.inbox, conversation, asked: message.message, note: null }
    ;(state.pending[ws] ??= []).push(entry)
    save()
    notes.set(entry, delivery.to(conversation, attempt => attempt(() => adapter.post(conversation, sent.started ? WORKING : STILL_WORKING)))
      .then(note => note, err => {
        log(`${where(conversation)}: no working message — ${said(err)}`)
        return null
      })
      .then(note => {
        entry.note = note
        save()
        return note
      }))
  }

  const handle = async (message) => {
    const { conversation } = message
    let read
    try {
      read = route()
    } catch (err) {
      return log(`refused ${where(conversation)}: the bot file is unreadable — ${said(err)}`)
    }
    const routed = read.table.get(conversation)
    if (!routed) return log(adapter.refusal(message, botFile))

    const reached = []
    for (const name of message.addresses ?? routed.spores) {
      let ws
      try {
        ws = sporeOf(name, read.config)
      } catch (err) {
        log(`${where(conversation)}: "${name}" — ${said(err)}`)
        tell(conversation, `this ${noun} points at "${name}", which is not a spore name — tell whoever runs me`)
        continue
      }
      if (!ws) {
        log(`${where(conversation)}: no spore "${name}"`)
        tell(conversation, `there is no spore called "${name}" — tell whoever runs me`)
        continue
      }
      reached.push({ name, ws })
    }
    if (!reached.length) return

    if (message.text === null) return tell(conversation, 'only text reaches a spore for now')
    if (message.command && reached.length === 1 && (!message.command.args || TAKES_ARGUMENTS.has(message.command.verb))) {
      return obey(conversation, reached[0].ws, message.command.verb, message.command.args)
    }
    for (const { name, ws } of reached) pass(message, name, ws)
    if (message.files) tell(conversation, unpassed(message.files, reached.map(one => one.name)))
  }

  const listen = () => adapter.listen({
    onMessage: async (message) => {
      try {
        await handle(message)
      } catch (err) {
        log(`${where(message.conversation)}: message ${message.id} — ${said(err)}`)
        tell(message.conversation, `that failed — ${err.message}`)
      }
    },
    signal: stopping.signal,
    log,
    sleep: (ms) => sleep(ms, stopping.signal)
  })

  const spores = () => {
    let read
    try {
      read = route()
      routeFailure = null
    } catch (err) {
      if (routeFailure !== err.message) log(`bot file: ${said(err)} — following the spores it last named`)
      routeFailure = err.message
      return [...followed.keys()]
    }
    detailed = new Set([...read.table].filter(([, routed]) => routed.details).map(([conversation]) => conversation))
    const next = new Map()
    for (const [conversation, { spores: names }] of read.table) {
      for (const name of names) {
        let ws
        try {
          ws = sporeOf(name, read.config)
        } catch {
          // Told to the conversation, and logged, when someone there next writes.
          continue
        }
        if (!ws) continue
        const one = next.get(ws) ?? { name, conversations: new Set() }
        one.conversations.add(conversation)
        next.set(ws, one)
      }
    }
    let moved = false
    for (const ws of Object.keys(state.cursors)) {
      if (next.has(ws)) continue
      delete state.cursors[ws]
      delete state.pending[ws]
      moved = true
    }
    for (const ws of next.keys()) moved = follows(ws) || moved
    if (moved) save()
    followed = next
    return [...next.keys()]
  }

  /**
   * The calls at work, edited into each `working…` message. Progress is the one thing the relay
   * drops: an edit the platform turns away for now is not tried again, and none is tried in that
   * conversation until the wait it named has passed, so an answer never queues behind one.
   */
  const repaint = (ws) => {
    const lines = shown.get(ws)
    lines.timer = null
    lines.at = Date.now()
    for (const entry of state.pending[ws] ?? []) {
      const { conversation } = entry
      const text = [WORKING, ...render(lines.items, { detailed: detailed.has(conversation) })].join('\n')
      delivery.to(conversation, async () => {
        const note = await noteOf(entry)
        if (note === null || !state.pending[ws]?.includes(entry) || Date.now() < (limitedUntil.get(conversation) ?? 0)) return
        try {
          await adapter.edit(conversation, note, text)
        } catch (err) {
          if (!err.retryable) throw err
          if (err.context?.retryAfter) limitedUntil.set(conversation, Date.now() + err.context.retryAfter * 1000)
          log(`${where(conversation)}: progress dropped — ${said(err)}`)
        }
      }).catch(err => log(`${where(conversation)}: progress not shown — ${said(err)}`))
    }
  }

  const onEvent = (ws, event) => {
    if (!state.pending[ws]?.length) return
    const lines = shown.get(ws) ?? { items: [], timer: null, at: 0 }
    shown.set(ws, lines)
    if (!track(lines.items, event)) return
    if (!lines.timer) lines.timer = setTimeout(() => repaint(ws), Math.max(0, editEveryMs - (Date.now() - lines.at)))
  }

  const forget = (ws, gone) => {
    const kept = (state.pending[ws] ?? []).filter(note => !gone.includes(note))
    if (kept.length) state.pending[ws] = kept
    else delete state.pending[ws]
    save()
  }

  const hand = async (attempt, conversation, ws, { files, more }) => {
    for (const file of files) {
      const path = resolve(ws, file.path)
      if (!existsSync(path)) {
        await attempt(() => adapter.post(conversation, `${file.path} is no longer there`))
        continue
      }
      const bytes = statSync(path).size
      if (!adapter.can.upload) {
        await attempt(() => adapter.post(conversation, `${file.path} is in the spore's workspace`))
        continue
      }
      if (bytes > adapter.limits.file) {
        await attempt(() => adapter.post(conversation, `${file.path} is ${(bytes / 1024 / 1024).toFixed(0)} MB, more than ${adapter.label} takes; it is in the spore's workspace`))
        continue
      }
      await attempt(() => adapter.upload(conversation, { path, mime: file.mime }, file.path))
    }
    if (more) await attempt(() => adapter.post(conversation, leftOut(more)))
  }

  /**
   * A `working…` message whose answer is posted below it: removed, or, where the platform will not
   * remove it, marked answered. The answer is already there, so nothing here can fail the delivery.
   */
  const retire = async (attempt, conversation, note) => {
    if (note === null) return
    if (adapter.can.remove) {
      try {
        return await attempt(() => adapter.remove(conversation, note))
      } catch (err) {
        log(`${where(conversation)}: working message ${note} not removed — ${said(err)}`)
      }
    }
    await attempt(() => adapter.edit(conversation, note, ANSWERED))
      .catch(err => log(`${where(conversation)}: working message ${note} not marked answered — ${said(err)}`))
  }

  /**
   * One outbox entry of this bot's posted to its conversation — the answer a new message, so it
   * notifies however long the turn ran, replying to the message it answers — and settled:
   * delivered once the platform took it, refused when the conversation does not reach this spore
   * or the platform will not take it. One the platform still did not take when its retries ran out
   * stays pending for the next pass. It is marked before its first post, so one found marked —
   * the service stopped between posting and settling, or an earlier pass ran out of retries — may
   * have been posted already, and says so. True when it is settled.
   */
  const deliver = async (ws, entry) => {
    const conversation = entry.recipient.slice(prefix.length)
    const mine = (state.pending[ws] ?? []).filter(note => note.conversation === conversation && entry.answers.includes(note.inbox))
    if (!followed.get(ws)?.conversations.has(conversation)) {
      const reason = `${where(conversation)} does not reach this spore through ${botFile}`
      settleOutbox(ws, entry.outboxNo, { refused: reason })
      log(`turn ${entry.turnNo} of ${ws}: refused — ${reason}`)
      forget(ws, mine)
      return true
    }
    const turn = turnsSince(ws, entry.turnNo - 1).ended[0]
    const heard = turn.asked.filter(message => entry.answers.includes(message.inboxNo))
    const answer = heard.some(message => message.replyTo) ? reply(turn) : announce({ record: turn.record, asked: heard })
    const text = entry.attemptedAt === null ? answer : `${MAY_REPEAT}\n\n${answer}`
    const handed = { files: turn.record.deliverables ?? [], more: turn.record.deliverablesMore ?? 0 }
    const answering = mine.at(-1)?.asked ?? null
    const formatted = async (part, options) => {
      try {
        return await adapter.post(conversation, part, { ...options, markdown: true })
      } catch (err) {
        if (!err.context?.formatRefused) throw err
        log(`${where(conversation)}: ${adapter.label} refused the formatting (${said(err)}), sent as plain text`)
        return adapter.post(conversation, part, options)
      }
    }
    attemptOutbox(ws, entry.outboxNo)
    try {
      await delivery.to(conversation, async (attempt) => {
        const [first, ...rest] = pieces(text, adapter.limits.message)
        await attempt(() => formatted(first, { answering }))
        for (const part of rest) await attempt(() => formatted(part, {}))
        await hand(attempt, conversation, ws, handed)
        for (const note of mine) await retire(attempt, conversation, await noteOf(note))
      })
    } catch (err) {
      if (err.retryable || stopping.signal.aborted) {
        log(`turn ${entry.turnNo} of ${ws}: not delivered to ${where(conversation)} yet — ${said(err)}`)
        return false
      }
      settleOutbox(ws, entry.outboxNo, { refused: said(err) })
      log(`turn ${entry.turnNo} of ${ws}: ${where(conversation)} refused it — ${said(err)}`)
      forget(ws, mine)
      return true
    }
    settleOutbox(ws, entry.outboxNo)
    forget(ws, mine)
    return true
  }

  /**
   * This bot's pending outbox entries of `ws`, delivered in order, and none once the service is
   * stopping, since a post cut off by the exit is one that may repeat: the messages still owed an
   * answer, or null when the spore's database could not be read or written — a busy one — and
   * what it holds waits for the next pass.
   */
  const drain = async (ws) => {
    const owed = new Set()
    try {
      for (const entry of outbox(ws, { kind, state: 'pending' })) {
        if (!entry.recipient.startsWith(prefix)) continue
        if (stopping.signal.aborted || !(await deliver(ws, entry))) entry.answers.forEach(inboxNo => owed.add(inboxNo))
      }
    } catch (err) {
      log(`${ws}: its outbox could not be read or settled — ${said(err)}`)
      return null
    }
    return owed
  }

  const tellWaiting = async (attempt, entry, text) => {
    const note = await noteOf(entry)
    if (note === null) return attempt(() => adapter.post(entry.conversation, text))
    try {
      await attempt(() => adapter.edit(entry.conversation, note, text))
    } catch (err) {
      if (err.retryable) throw err
      log(`${where(entry.conversation)}: working message ${note} cannot be edited (${said(err)}), saying it anew`)
      await attempt(() => adapter.post(entry.conversation, text))
    }
  }

  const onTurn = async (ws, turn) => {
    clearTimeout(shown.get(ws)?.timer)
    shown.delete(ws)

    const read = new Set(turn.asked.map(entry => entry.inboxNo))
    const left = (state.pending[ws] ?? []).filter(entry => !read.has(entry.inbox))
    if (left.length && stateOf(ws).state !== RUNNING) {
      const work = left.map(entry => delivery.to(entry.conversation, attempt => tellWaiting(attempt, entry, waiting(turn))))
      for (const outcome of await Promise.allSettled(work)) {
        if (outcome.status === 'rejected') log(`turn ${turn.record.turnNo} of ${ws}: not told it is waiting — ${said(outcome.reason)}`)
      }
    }

    const owed = await drain(ws)
    if (owed) forget(ws, (state.pending[ws] ?? []).filter(note => read.has(note.inbox) && !owed.has(note.inbox)))
  }

  const follow = async () => {
    const { signal } = stopping
    for (const ws of spores()) await drain(ws)
    for await (const item of watchAll(spores, { cursors: state.cursors, tick: followEveryMs, signal })) {
      if (item.event) {
        onEvent(item.ws, item.event)
        continue
      }
      await onTurn(item.ws, item.turn)
      if (signal.aborted) break
      state.cursors[item.ws] = item.cursor
      save()
    }
  }

  const run = async (signal) => {
    signal.addEventListener('abort', () => stopping.abort(), { once: true })
    const failed = []
    const halt = (err) => {
      failed.push(err)
      stopping.abort()
    }
    await Promise.all([listen().catch(halt), follow().catch(halt)])
    for (const lines of shown.values()) clearTimeout(lines.timer)
    save()
    if (failed.length) throw failed[0]
  }

  return { run }
}
