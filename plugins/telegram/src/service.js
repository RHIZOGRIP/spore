import { existsSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import { CONFIG_FILE, changeText, databaseOf, durationText, extendTurn, isWorkspace, lastEventSeq, loadEnvironment, outbox, readConfig, RUNNING, runningLines, send, settleOutbox, show, SporeError, stateOf, stop, turnsSince, watchAll, workspaceFor, wrapTurn } from '@rhizogrip/spore'
import { allowed, detailedChats, tokenVariables } from './bots.js'
import { createDelivery } from './delivery.js'
import { announce, pieces, render, reply, track, waiting } from './forward.js'
import { loadState, saveState } from './state.js'

const MAX_DOCUMENT = 50 * 1024 * 1024
const COMMAND = /^\/([a-z]+)(@\w+)?(?:\s+(.+))?$/is
const NOT_MODIFIED = /message is not modified/
const TAKES_ARGUMENTS = new Set(['extend', 'wrap'])
const HELP = 'Anything you write here goes to the spore. /status says what it is doing; /stop ends the turn it is running; /wrap [10m] asks it to wrap up; /extend wall 30m gives it more, as far as its spore.cmk allows.'

const pause = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

const said = (err) => [err.message, err.detail].filter(Boolean).join(' — ')

/**
 * One bot, routed by `botFile`. `env` is the environment the service was started with, before
 * `environment` beside `config.json` was read: that file is read again for every turn, so a key
 * added to it reaches the next turn without a restart, and a variable the service was started with
 * still wins. No bot's token is passed on.
 */
export function createService ({ telegram, botFile, statePath, env, log, configFile = CONFIG_FILE, sleep = pause, editEveryMs = 2500, followEveryMs = 1000 }) {
  const sendEnv = () => {
    const fresh = { ...env }
    loadEnvironment(configFile, fresh)
    for (const variable of tokenVariables(configFile)) delete fresh[variable]
    return fresh
  }
  const replyTo = `telegram:${basename(botFile, '.json')}/`
  const state = loadState(statePath)
  const stopping = new AbortController()
  const delivery = createDelivery({ sleep: (ms) => sleep(ms, stopping.signal), signal: stopping.signal })
  const notes = new WeakMap()
  const shown = new Map()
  let chatsOf = new Map()
  let detailed = new Set()
  let routeFailure = null

  const save = () => saveState(statePath, state)
  const noteOf = (entry) => notes.get(entry) ?? Promise.resolve(entry.message)

  const route = () => {
    const config = readConfig(configFile)
    return { config, table: allowed(botFile), detailed: detailedChats(botFile) }
  }
  const sporeOf = (name, config) => {
    const ws = workspaceFor(name, { config }).path
    return isWorkspace(ws) ? ws : null
  }

  const tell = (chat, text) => delivery.to(chat, async (attempt) => {
    for (const part of pieces(text)) await attempt(() => telegram.say(chat, part))
  }).catch(err => log(`chat ${chat}: not delivered — ${said(err)}`))

  const edit = async (attempt, chat, message, text) => {
    const [first, ...rest] = pieces(text)
    if (message === null) {
      await attempt(() => telegram.say(chat, first))
    } else {
      try {
        await attempt(() => telegram.revise(chat, message, first))
      } catch (err) {
        if (!NOT_MODIFIED.test(err.detail ?? '')) {
          if (err.retryable) throw err
          log(`chat ${chat}: message ${message} cannot be edited (${err.detail}), sending the text anew`)
          await attempt(() => telegram.say(chat, first))
        }
      }
    }
    for (const part of rest) await attempt(() => telegram.say(chat, part))
  }

  const hand = async (attempt, chat, ws, files) => {
    for (const file of files) {
      const path = resolve(ws, file.path)
      if (!existsSync(path)) {
        await attempt(() => telegram.say(chat, `${file.path} is no longer there`))
        continue
      }
      const bytes = statSync(path).size
      if (bytes > MAX_DOCUMENT) {
        await attempt(() => telegram.say(chat, `${file.path} is ${(bytes / 1024 / 1024).toFixed(0)} MB, more than Telegram takes; it is in the spore's workspace`))
        continue
      }
      await attempt(() => telegram.document(chat, { path, mime: file.mime }, file.path))
    }
  }

  const status = (ws) => {
    const one = show({ ws, configFile })
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

  const change = (chat, ws, act) => {
    let answer
    try {
      answer = act()
    } catch (err) {
      return tell(chat, said(err))
    }
    return tell(chat, changeText(answer))
  }

  const obey = (chat, ws, command, args = '') => {
    if (command === 'stop') return tell(chat, stop(ws).stopped ? 'stopping it' : 'nothing is running')
    if (command === 'status') return tell(chat, status(ws))
    if (command === 'wrap') return change(chat, ws, () => wrapTurn(ws, args.trim() || undefined))
    if (command === 'extend') {
      const [dimension, amount] = args.trim().split(/\s+/)
      if (!dimension) return tell(chat, '/extend wall 30m, /extend cost 1.50 or /extend rounds 20')
      return change(chat, ws, () => extendTurn(ws, dimension, amount))
    }
    return tell(chat, HELP)
  }

  const follows = (ws) => {
    if (state.cursors[ws]) return false
    state.cursors[ws] = { seq: lastEventSeq(ws), turn: stateOf(ws).lastTurnNo, database: databaseOf(ws) }
    return true
  }

  const pass = (chat, ws, text, update) => {
    if (follows(ws)) save()
    let sent
    try {
      sent = send(ws, text, { requestId: `telegram:${update}`, replyTo: `${replyTo}${chat}`, env: sendEnv() })
    } catch (err) {
      log(`chat ${chat}: send refused — ${err.type} ${said(err)}`)
      return tell(chat, err.type === 'ADMISSION_FULL' ? `busy — ${said(err)}` : `not delivered — ${said(err)}`)
    }
    if (sent.repeated) return log(`chat ${chat}: update ${update} was already delivered, as inbox ${sent.inbox}`)

    const entry = { inbox: sent.inbox, chat, message: null }
    ;(state.pending[ws] ??= []).push(entry)
    save()
    notes.set(entry, delivery.to(chat, attempt => attempt(() => telegram.say(chat, sent.started ? 'working…' : 'heard you — still working…')))
      .then(note => note.message_id, err => {
        log(`chat ${chat}: no working message — ${said(err)}`)
        return null
      })
      .then(message => {
        entry.message = message
        save()
        return message
      }))
  }

  const handle = async (update) => {
    const message = update.message
    const chat = message?.chat?.id
    if (chat === undefined) return

    let read
    try {
      read = route()
    } catch (err) {
      return log(`refused chat ${chat}: the allow-list is unreadable — ${said(err)}`)
    }
    const name = read.table[String(chat)]
    if (!name) {
      const who = message.from?.username ? ` (@${message.from.username})` : ''
      return log(`refused chat ${chat}${who} — to allow it, add "${chat}": "<a spore>" to the chats of ${botFile}`)
    }
    let ws
    try {
      ws = sporeOf(name, read.config)
    } catch (err) {
      log(`chat ${chat}: "${name}" — ${said(err)}`)
      return tell(chat, `this chat points at "${name}", which is not a spore name — tell whoever runs me`)
    }
    if (!ws) {
      log(`chat ${chat}: no spore "${name}"`)
      return tell(chat, `there is no spore called "${name}" — tell whoever runs me`)
    }

    const text = message.text?.trim()
    if (!text) return tell(chat, 'only text reaches a spore for now')
    const command = text.match(COMMAND)
    const asked = command?.[1].toLowerCase()
    if (command && (!command[3] || TAKES_ARGUMENTS.has(asked))) return obey(chat, ws, asked, command[3])
    pass(chat, ws, text, update.update_id)
  }

  const listen = async () => {
    const { signal } = stopping
    let offset
    let backoff = 1000
    while (!signal.aborted) {
      let updates
      try {
        updates = await telegram.updates(offset, { signal })
        backoff = 1000
      } catch (err) {
        if (signal.aborted) break
        if (err.context?.status === 409) {
          throw new SporeError('another process is taking this bot\'s updates', { type: 'TELEGRAM_CONFLICT', detail: err.detail })
        }
        if (!err.retryable) throw err
        log(`poll failed — ${said(err)}`)
        await sleep(err.context?.retryAfter ? err.context.retryAfter * 1000 : backoff, signal)
        backoff = Math.min(backoff * 2, 60_000)
        continue
      }
      for (const update of updates) {
        try {
          await handle(update)
        } catch (err) {
          log(`update ${update.update_id}: ${said(err)}`)
          const chat = update.message?.chat?.id
          if (chat !== undefined) tell(chat, `that failed — ${err.message}`)
        }
        offset = update.update_id + 1
      }
    }
    if (offset !== undefined) {
      await telegram.updates(offset, { seconds: 0 }).catch(err => log(`could not confirm the last updates — ${said(err)}`))
    }
  }

  const spores = () => {
    let read
    try {
      read = route()
      routeFailure = null
    } catch (err) {
      if (routeFailure !== err.message) log(`allow-list: ${said(err)} — following the spores it last named`)
      routeFailure = err.message
      return [...chatsOf.keys()]
    }
    detailed = read.detailed
    const next = new Map()
    for (const [chat, name] of Object.entries(read.table)) {
      let ws
      try {
        ws = sporeOf(name, read.config)
      } catch {
        // Told to the chat, and logged, when it next speaks.
        continue
      }
      if (ws) next.set(ws, [...(next.get(ws) ?? []), Number(chat)])
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
    chatsOf = next
    return [...next.keys()]
  }

  const repaint = (ws) => {
    const lines = shown.get(ws)
    lines.timer = null
    lines.at = Date.now()
    for (const entry of state.pending[ws] ?? []) {
      const text = ['working…', ...render(lines.items, { detailed: detailed.has(entry.chat) })].join('\n')
      delivery.to(entry.chat, async (attempt) => {
        const message = await noteOf(entry)
        if (message === null || !state.pending[ws]?.includes(entry)) return
        await attempt(() => telegram.revise(entry.chat, message, text))
      }).catch(err => { if (!NOT_MODIFIED.test(err.detail ?? '')) log(`chat ${entry.chat}: progress not shown — ${said(err)}`) })
    }
  }

  const onEvent = (ws, event) => {
    if (!state.pending[ws]?.length) return
    const lines = shown.get(ws) ?? { items: [], timer: null, at: 0 }
    shown.set(ws, lines)
    if (!track(lines.items, event)) return
    if (!lines.timer) lines.timer = setTimeout(() => repaint(ws), Math.max(0, editEveryMs - (Date.now() - lines.at)))
  }

  const forget = (ws, notes) => {
    const kept = (state.pending[ws] ?? []).filter(note => !notes.includes(note))
    if (kept.length) state.pending[ws] = kept
    else delete state.pending[ws]
    save()
  }

  /**
   * One outbox entry of this bot's posted to its chat — into the `working…` messages of what it
   * answers when the chat has them — and settled: delivered once Telegram took it, refused when
   * the chat does not reach this spore or Telegram will not take it. One Telegram still did not
   * take when its retries ran out stays pending for the next pass. True when it is settled.
   */
  const deliver = async (ws, entry) => {
    const chat = Number(entry.recipient.slice(replyTo.length))
    const notes = (state.pending[ws] ?? []).filter(note => note.chat === chat && entry.answers.includes(note.inbox))
    if (!(chatsOf.get(ws) ?? []).includes(chat)) {
      const reason = `chat ${entry.recipient.slice(replyTo.length)} does not reach this spore through ${botFile}`
      settleOutbox(ws, entry.outboxNo, { refused: reason })
      log(`turn ${entry.turnNo} of ${ws}: refused — ${reason}`)
      forget(ws, notes)
      return true
    }
    const turn = turnsSince(ws, entry.turnNo - 1).ended[0]
    const heard = turn.asked.filter(message => entry.answers.includes(message.inboxNo))
    const text = heard.some(message => message.replyTo) ? reply(turn) : announce({ record: turn.record, asked: heard })
    const files = (turn.record.produced ?? []).filter(file => file.delivered)
    try {
      await delivery.to(chat, async (attempt) => {
        if (notes.length) {
          for (const note of notes) await edit(attempt, chat, await noteOf(note), text)
        } else {
          for (const part of pieces(text)) await attempt(() => telegram.say(chat, part))
        }
        await hand(attempt, chat, ws, files)
      })
    } catch (err) {
      if (err.retryable || stopping.signal.aborted) {
        log(`turn ${entry.turnNo} of ${ws}: not delivered to chat ${chat} yet — ${said(err)}`)
        return false
      }
      settleOutbox(ws, entry.outboxNo, { refused: said(err) })
      log(`turn ${entry.turnNo} of ${ws}: chat ${chat} refused it — ${said(err)}`)
      forget(ws, notes)
      return true
    }
    settleOutbox(ws, entry.outboxNo)
    forget(ws, notes)
    return true
  }

  /**
   * This bot's pending outbox entries of `ws`, delivered in order: the messages still owed an
   * answer, or null when the spore's database could not be read or written — a busy one — and
   * what it holds waits for the next pass.
   */
  const drain = async (ws) => {
    const owed = new Set()
    try {
      for (const entry of outbox(ws, { kind: 'telegram', state: 'pending' })) {
        if (!entry.recipient.startsWith(replyTo)) continue
        if (!(await deliver(ws, entry))) entry.answers.forEach(inboxNo => owed.add(inboxNo))
      }
    } catch (err) {
      log(`${ws}: its outbox could not be read or settled — ${said(err)}`)
      return null
    }
    return owed
  }

  const onTurn = async (ws, turn) => {
    clearTimeout(shown.get(ws)?.timer)
    shown.delete(ws)

    const read = new Set(turn.asked.map(entry => entry.inboxNo))
    const left = (state.pending[ws] ?? []).filter(entry => !read.has(entry.inbox))
    if (left.length && stateOf(ws).state !== RUNNING) {
      const work = left.map(entry => delivery.to(entry.chat, async (attempt) => edit(attempt, entry.chat, await noteOf(entry), waiting(turn))))
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
