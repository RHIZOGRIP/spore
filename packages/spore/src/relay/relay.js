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

import { approvalHookVariables, attemptOutbox, changeText, extendTurn, isWorkspace, lastEventSeq, loadEnvironment, outbox, readConfig, RUNNING, send, setAside, settleOutbox, stateOf, stop, turnsSince, watchAll, workspaceFor, wrapTurn, CONFIG_FILE, databaseOf } from '../index.js'
import { createApprovals } from './approvals.js'
import { credentialVariables, filesOf, reactionsOf, routesOf } from './bot-file.js'
import { createDelivery } from './delivery.js'
import { announce, endingOf, leftOut, notCome, originOf, pieces, reply, sizeOf, statusText, waiting } from './render.js'
import { applyEvent, createLive, renderLive } from '../library/live.js'
import { isZone, runningLimits } from '../core/spore-dir.js'
import { loadState, saveState } from './state.js'

const TAKES_ARGUMENTS = new Set(['extend', 'wrap'])
const OPERATING = new Set(['stop', 'wrap', 'extend'])
const WORKING = 'working…'
const STILL_WORKING = 'heard you — still working…'
const ANSWERED = 'answered below'
const SET_ASIDE = 'set aside'
const SETTLE_EVERY_MS = 1000
const MAY_REPEAT = '(this may repeat an earlier message)'
const FILES_MOST = 10
const FETCH_TRIES = 3

const pause = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

const said = (err) => [err.message, err.detail].filter(Boolean).join(' — ')

const firstLine = (text) => text.split('\n')[0].slice(0, 200)

/** Whether `people` — ids, `role:<id>` and `*` — lets `person` address the spores. */
const admits = (people, person) =>
  people.includes('*') || people.includes(person.id) || person.groups.some(group => people.includes(`role:${group}`))

/**
 * What a message is to the spores its conversation reaches, decided in one place: `pass`, said to
 * them; `overhear`, given to them as said around them, where the routing overhears; or dropped at
 * the gate named — `unaddressed`, a message naming none of them, and `unlisted`, from someone the
 * routing's people do not name. Only someone who may address a spore is overheard by it.
 */
const admission = (message, routed) => {
  if (message.spore !== null) return 'pass'
  const listed = routed.people === null || admits(routed.people, message.person)
  if (message.addresses?.length === 0) return listed && routed.overhear ? 'overhear' : 'unaddressed'
  return listed ? 'pass' : 'unlisted'
}

/**
 * Whether the person may stop, wrap or extend a turn: anyone in a conversation of their own, and in
 * one many people share, someone its people name by id or role — not everyone `*` lets talk.
 */
const operates = (message, routed) =>
  !message.shared || routed.people === null || admits(routed.people.filter(who => who !== '*'), message.person)

export function createRelay ({ adapter, botFile, statePath, env, log, configFile = CONFIG_FILE, sleep = pause, editEveryMs = adapter.limits.editEveryMs, typingEveryMs = adapter.limits.typingEveryMs, followEveryMs = 1000, approveEveryMs = 1000 }) {
  const { kind, noun } = adapter
  const prefix = `${kind}:${basename(botFile, '.json')}/`
  const kept = new Set(adapter.sourceVariables)
  const environment = () => {
    const fresh = { ...env }
    loadEnvironment(configFile, fresh)
    return fresh
  }
  const sendEnv = () => {
    const fresh = environment()
    const secrets = [...credentialVariables(adapter, configFile), ...approvalHookVariables(readConfig(configFile))]
    for (const variable of secrets) if (!kept.has(variable)) delete fresh[variable]
    return fresh
  }
  const state = loadState(statePath, adapter)
  const stopping = new AbortController()
  const delivery = createDelivery({ sleep: (ms) => sleep(ms, stopping.signal), signal: stopping.signal })
  const notes = new WeakMap()
  const shown = new Map()
  const painted = new WeakMap()
  const limitedUntil = new Map()
  const hinted = new Set()
  let followed = new Map()
  let detailed = new Set()
  let briefed = new Set()
  let routeFailure = null

  const save = () => saveState(statePath, state, adapter)
  if (adapter.stateFields.length) adapter.restore(state, save)
  const noteOf = (entry) => notes.get(entry) ?? Promise.resolve(entry.note)
  const where = (conversation) => `${noun} ${conversation}`
  const keyOf = (conversation) => adapter.routeOf ? adapter.routeOf(conversation) : conversation

  const route = () => ({ config: readConfig(configFile), table: routesOf(adapter, botFile), react: adapter.can.react ? reactionsOf(adapter, botFile) : null, files: filesOf(adapter, botFile) })
  const approvals = createApprovals({
    adapter,
    prefix,
    botFile,
    configFile,
    keyOf,
    where,
    followed: () => followed,
    delivery,
    environment,
    sendEnv,
    log,
    sleep: (ms) => sleep(ms, stopping.signal),
    signal: stopping.signal
  })
  const sporeOf = (name, config) => {
    const ws = workspaceFor(name, { config }).path
    return isWorkspace(ws) ? ws : null
  }

  /** What the relay says itself, under the spore `as` names, or the bot's own name for null. */
  const tell = (conversation, text, as = null) => delivery.to(conversation, async (attempt) => {
    for (const part of pieces(text, adapter.limits.message)) await attempt(() => adapter.post(conversation, part, { as }))
  }).catch(err => log(`${where(conversation)}: not delivered — ${said(err)}`))

  /** Whom a post about `entries` answers: each person and the first line of what they said. */
  const forOf = (entries) => entries.map(entry => ({ person: entry.person, said: entry.said }))

  const change = (conversation, act, as, brief) => {
    let answer
    try {
      answer = act()
    } catch (err) {
      return tell(conversation, said(err), as)
    }
    return tell(conversation, changeText(answer, { brief }), as)
  }

  const messages = (n) => `${n} message${n === 1 ? '' : 's'}`

  /**
   * `stop`: the running turn signalled, and what this conversation said before it and no turn has
   * read — up to the last of its messages this relay passed — set aside once nothing holds the
   * spore, so no turn reads it later, and its `working…` message and reaction go. Followed in the
   * background: a turn may wait on its model calls.
   */
  const stopTurn = async (conversation, ws, name) => {
    const upto = Math.max(0, ...(state.pending[ws] ?? []).filter(entry => entry.conversation === conversation).map(entry => entry.inbox))
    try {
      const { stopped } = stop(ws)
      if (stopped) tell(conversation, 'stopping it', name)
      if (upto === 0) {
        if (!stopped) tell(conversation, 'nothing is running', name)
        return
      }
      let marked = null
      while (!stopping.signal.aborted) {
        if (stateOf(ws).state !== RUNNING) marked = setAside(ws, { replyTo: `${prefix}${conversation}`, upto })
        if (marked !== null) break
        await sleep(SETTLE_EVERY_MS, stopping.signal)
      }
      if (marked === null) return
      const gone = (state.pending[ws] ?? []).filter(entry => marked.includes(entry.inbox))
      for (const entry of gone) {
        delivery.to(conversation, async (attempt) => {
          await retire(attempt, conversation, await noteOf(entry), SET_ASIDE, forOf([entry]))
          if (entry.taken) await mark(attempt, conversation, entry.asked, () => [null, entry.taken])
        })
      }
      forget(ws, gone)
      if (!stopped) return tell(conversation, marked.length ? `nothing is running — set aside ${messages(marked.length)} that waited` : 'nothing is running', name)
      if (marked.length) tell(conversation, `set aside ${messages(marked.length)} you sent that no turn had read`, name)
    } catch (err) {
      log(`${where(conversation)}: nothing set aside — ${said(err)}`)
      tell(conversation, `nothing set aside — ${said(err)}`, name)
    }
  }

  const obey = (conversation, ws, name, verb, args, brief) => {
    if (verb === 'stop') {
      stopTurn(conversation, ws, name)
      return
    }
    if (verb === 'status') return tell(conversation, statusText(ws, configFile, { brief }), name)
    if (verb === 'wrap') return change(conversation, () => wrapTurn(ws, args.trim() || undefined), name, brief)
    if (verb === 'extend' && !brief) {
      const [dimension, amount] = args.trim().split(/\s+/)
      if (!dimension) return tell(conversation, adapter.usage.extend, name)
      return change(conversation, () => extendTurn(ws, dimension, amount), name)
    }
    return tell(conversation, brief ? adapter.usage.briefHelp : adapter.usage.help, name)
  }

  /**
   * What only shows a turn at work — progress, typing — is the one thing the relay drops: a call
   * the platform turns away for now is not tried again, and none is tried in that conversation
   * until the wait it named has passed, so an answer never queues behind one.
   */
  const droppable = (conversation, what, act) => delivery.to(conversation, async () => {
    if (Date.now() < (limitedUntil.get(conversation) ?? 0)) return
    try {
      await act()
    } catch (err) {
      if (!err.retryable) throw err
      if (err.context?.retryAfter) limitedUntil.set(conversation, Date.now() + err.context.retryAfter * 1000)
      log(`${where(conversation)}: ${what} dropped — ${said(err)}`)
    }
  }).catch(err => log(`${where(conversation)}: ${what} not shown — ${said(err)}`))

  /**
   * The bot's reaction on a person's message changed — `pick()` answers `[emoji, was]`, the one to
   * put or null for none and the one it put before — or logged when it cannot be.
   */
  const mark = (attempt, conversation, message, pick) => attempt(() => adapter.react(conversation, message, ...pick()))
    .catch(err => log(`${where(conversation)}: the reaction on message ${message} not changed — ${said(err)}`))

  const follows = (ws) => {
    if (state.cursors[ws]) return false
    state.cursors[ws] = { seq: lastEventSeq(ws), turn: stateOf(ws).lastTurnNo, database: databaseOf(ws) }
    return true
  }

  const requestOf = (message, name) => `${kind}:${message.id}${message.addresses ? `:${name}` : ''}`
  /** The person's clock, where the platform says it; one this Node does not know goes unsaid, and logged. */
  const zoneOf = ({ person, conversation }) => {
    if (person.zone === undefined || person.zone === null) return {}
    if (isZone(person.zone)) return { zone: person.zone }
    log(`${where(conversation)}: ${person.name}'s clock, ${JSON.stringify(person.zone)}, is no time zone this Node knows — their message goes without it`)
    return {}
  }

  const fromOf = (message) => ({
    name: message.person.name,
    id: `${kind}:${message.person.id}`,
    where: adapter.can.upload ? message.where : `${message.where}, which gets no files`,
    ...zoneOf(message)
  })

  /**
   * `show` is the conversation's, or, where the bot file leaves it, the platform's own for a
   * conversation many people share (`showShared`), and `working` for one with a single person, who
   * is shown what the turn does. What the platform adds for one spore (`aside`) follows the text.
   */
  const pass = (message, name, ws, { table, react }, attach) => {
    const { conversation } = message
    const routed = table.get(keyOf(conversation))
    const show = routed.show ?? (message.shared ? adapter.showShared : 'working')
    const taken = show === 'working' ? null : react.taken
    const aside = adapter.aside ? adapter.aside(message, name) : null
    if (follows(ws)) save()
    let sent
    try {
      sent = send(ws, [message.text, aside].filter(Boolean).join('\n\n'), {
        attach,
        requestId: requestOf(message, name),
        replyTo: `${prefix}${conversation}`,
        from: fromOf(message),
        ...(message.traceparent ? { traceparent: message.traceparent } : {}),
        env: sendEnv()
      })
    } catch (err) {
      log(`${where(conversation)}: send to ${name} refused — ${err.type} ${said(err)}`)
      if (taken) delivery.to(conversation, attempt => mark(attempt, conversation, message.message, () => [react.failed, null]))
      const busy = err.type === 'ADMISSION_FULL'
      if (routed.brief) return tell(conversation, busy ? 'busy — try again in a while' : 'not delivered — tell whoever runs me', name)
      return tell(conversation, busy ? `busy — ${said(err)}` : `not delivered — ${said(err)}`, name)
    }
    if (sent.repeated) return log(`${where(conversation)}: message ${message.id} was already said to ${name}, as inbox ${sent.inbox}`)

    const entry = { inbox: sent.inbox, conversation, asked: message.message, person: message.person.id, said: firstLine(message.text ?? message.files.map(file => file.name).join(', ')), note: null, taken }
    ;(state.pending[ws] ??= []).push(entry)
    save()
    if (taken) delivery.to(conversation, attempt => mark(attempt, conversation, message.message, () => [taken, null]))
    if (show === 'react') return
    notes.set(entry, delivery.to(conversation, attempt => attempt(() => adapter.post(conversation, sent.started ? WORKING : STILL_WORKING, { as: name, for: forOf([entry]) })))
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

  /**
   * Said around the spore and not to it: in its inbox for the next turn, which starts for it no
   * sooner and owes it nothing. What came with it is named and not fetched.
   */
  const overhear = (message, name, ws) => {
    if (message.text === null && !message.files.length) return
    const attach = message.files.map(file => ({ name: file.name, mime: file.mime, bytes: file.bytes, missing: 'said around you, so not fetched' }))
    try {
      send(ws, message.text ?? '', { attach, requestId: requestOf(message, name), from: fromOf(message), overheard: true })
    } catch (err) {
      log(`${where(message.conversation)}: what ${message.person.name} said was not given to ${name} — ${err.type} ${said(err)}`)
    }
  }

  /**
   * Someone in a conversation the bot file does not name is told nothing; the bot's owner is told,
   * once per conversation while the service runs, in each conversation of this bot that a spore's
   * `replyTo` default names and that is not brief, with the line that would let them in.
   */
  const hint = (message, { config, table }) => {
    if (hinted.has(message.conversation)) return
    hinted.add(message.conversation)
    const places = new Set(Object.values(config.replyTo ?? {})
      .filter(place => place.startsWith(prefix))
      .map(place => place.slice(prefix.length))
      .filter(conversation => table.has(keyOf(conversation)) && !table.get(keyOf(conversation)).brief))
    for (const place of places) tell(place, `${message.person.name} wrote from ${message.where}, which ${botFile} does not name.\n${adapter.refusal(message, botFile)}`)
  }

  /**
   * A conversation the bot file does not name: the line that would let it in, logged and told to the
   * owner — or nothing, where the platform shows the bot conversations that are none of its business,
   * and for what was not said to the bot at all.
   */
  const unnamed = (message, read) => {
    if (message.addresses?.length === 0) return
    const refused = adapter.refusal(message, botFile)
    if (refused === null) return
    log(refused)
    hint(message, read)
  }

  const fetchFile = async (ref, most) => {
    for (let tried = 1; ; tried++) {
      try {
        return await adapter.fetch(ref, { most })
      } catch (err) {
        if (!err.retryable || tried === FETCH_TRIES || stopping.signal.aborted) throw err
        await sleep(1000, stopping.signal)
      }
    }
  }

  /**
   * The files a message brought, fetched with the bot's credential up to `most` bytes each and
   * `FILES_MOST` a message, as `send`'s `attach`: what did not come is kept there with why, and
   * the conversation is told.
   */
  const gather = async (message, most, as) => {
    const attach = []
    for (const [i, file] of message.files.entries()) {
      const missing = (why) => attach.push({ name: file.name, mime: file.mime, bytes: file.bytes, missing: why })
      const over = (bytes) => `${bytes ? `${sizeOf(bytes)}, ` : ''}over the ${sizeOf(most)} this bot takes`
      if (i >= FILES_MOST) missing(`only ${FILES_MOST} files of a message reach a spore`)
      else if (most === 0) missing('this bot takes no files')
      else if (file.ref === null) missing(file.why)
      else if (file.bytes !== null && file.bytes > most) missing(over(file.bytes))
      else {
        try {
          attach.push({ name: file.name, mime: file.mime, data: await fetchFile(file.ref, most) })
        } catch (err) {
          log(`${where(message.conversation)}: ${file.name} from message ${message.id} not fetched — ${said(err)}`)
          missing(err.type === 'FILE_TOO_LARGE' ? over(err.context?.bytes) : `it could not be fetched — ${err.detail ?? err.message}`)
        }
      }
    }
    const lost = attach.filter(one => one.missing !== undefined)
    if (lost.length) tell(message.conversation, notCome(lost), as)
    return attach
  }

  const handle = async (message) => {
    const { conversation } = message
    let read
    try {
      read = route()
    } catch (err) {
      return log(`refused ${where(conversation)}: the bot file is unreadable — ${said(err)}`)
    }
    const routed = read.table.get(keyOf(conversation))
    if (!routed) return unnamed(message, read)
    const gate = admission(message, routed)
    if (gate === 'unaddressed') return
    const allow = `add "${message.person.id}" to its people in ${botFile}`
    if (gate === 'unlisted') return log(`refused ${message.person.name} (${message.person.id}) in ${where(conversation)} — to allow them, ${allow}`)

    const reached = []
    for (const name of message.addresses?.length ? message.addresses : routed.spores) {
      let ws
      try {
        ws = sporeOf(name, read.config)
      } catch (err) {
        log(`${where(conversation)}: "${name}" — ${said(err)}`)
        if (gate === 'pass') tell(conversation, `this ${noun} points at "${name}", which is not a spore name — tell whoever runs me`, name)
        continue
      }
      if (!ws) {
        log(`${where(conversation)}: no spore "${name}"`)
        if (gate === 'pass') tell(conversation, `there is no spore called "${name}" — tell whoever runs me`, name)
        continue
      }
      reached.push({ name, ws })
    }
    if (gate === 'overhear') return reached.forEach(({ name, ws }) => overhear(message, name, ws))
    if (!reached.length) return

    const [first] = reached
    if (message.text === null && !message.files.length) return tell(conversation, 'only text and files reach a spore', first.name)
    if (message.command && reached.length === 1 && (!message.command.args || TAKES_ARGUMENTS.has(message.command.verb))) {
      const verb = routed.brief && message.command.verb === 'extend' ? 'help' : message.command.verb
      if (OPERATING.has(verb) && !operates(message, routed)) {
        log(`refused ${verb} from ${message.person.name} (${message.person.id}) in ${where(conversation)} — only someone its people name may ${verb} a turn: ${allow}`)
        return tell(conversation, `only the people this ${noun} lists may ${verb} a turn`, first.name)
      }
      return obey(conversation, first.ws, first.name, verb, message.command.args ?? '', routed.brief)
    }
    const attach = message.files.length ? await gather(message, read.files, first.name) : []
    for (const { name, ws } of reached) pass(message, name, ws, read, attach)
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
    onChoice: async (choice) => {
      try {
        await approvals.choose(choice)
      } catch (err) {
        log(`${where(choice.conversation)}: a press — ${said(err)}`)
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
    briefed = new Set([...read.table].filter(([, routed]) => routed.brief).map(([conversation]) => conversation))
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

  const levelOf = (conversation) => detailed.has(keyOf(conversation)) ? 'details' : briefed.has(keyOf(conversation)) ? 'brief' : 'plain'
  const textFor = (live, entry, now) => renderLive(live, { level: levelOf(entry.conversation), now }).join('\n')

  /** The running turn's default rendering, edited into each `working…` message whose text it changes. */
  const repaint = (ws) => {
    const lines = shown.get(ws)
    lines.timer = null
    lines.at = Date.now()
    for (const entry of state.pending[ws] ?? []) {
      const { conversation } = entry
      const text = textFor(lines.live, entry, lines.at)
      if (text === painted.get(entry)) continue
      droppable(conversation, 'progress', async () => {
        const note = await noteOf(entry)
        if (note === null || !state.pending[ws]?.includes(entry)) return
        await adapter.edit(conversation, note, text, { for: forOf([entry]) })
        painted.set(entry, text)
      })
    }
  }

  const startedAtOf = (ws) => {
    try {
      return runningLimits(ws)?.startedAt ?? null
    } catch (err) {
      log(`${ws}: when its turn started is not known, so its working message shows no time — ${said(err)}`)
      return null
    }
  }

  /**
   * The platform's typing, renewed in each conversation that shows its turns with a reaction while
   * a spore is running a turn one of its messages waits on. A message from the bot clears it, so it
   * is never renewed past the answer.
   */
  const type = () => {
    for (const [ws, entries] of Object.entries(state.pending)) {
      const reacting = new Set(entries.filter(entry => entry.taken).map(entry => entry.conversation))
      if (!reacting.size) continue
      try {
        if (stateOf(ws).state !== RUNNING) continue
      } catch (err) {
        log(`${ws}: not known to be running — ${said(err)}`)
        continue
      }
      for (const conversation of reacting) {
        droppable(conversation, 'typing', async () => {
          if (state.pending[ws]?.some(entry => entry.taken && entry.conversation === conversation)) await adapter.typing(conversation)
        })
      }
    }
  }

  const onEvent = (ws, event) => {
    if (!state.pending[ws]?.length) return
    if (!shown.has(ws)) shown.set(ws, { live: createLive({ startedAt: startedAtOf(ws) }), timer: null, at: 0 })
    const lines = shown.get(ws)
    applyEvent(lines.live, event)
    if (lines.timer) return
    const now = Date.now()
    if (state.pending[ws].every(entry => textFor(lines.live, entry, now) === painted.get(entry))) return
    lines.timer = setTimeout(() => repaint(ws), Math.max(0, editEveryMs - (now - lines.at)))
  }

  const forget = (ws, gone) => {
    const kept = (state.pending[ws] ?? []).filter(note => !gone.includes(note))
    if (kept.length) state.pending[ws] = kept
    else delete state.pending[ws]
    save()
  }

  /**
   * The files a turn handed back, uploaded where the platform takes them. One that is not names
   * its place in the workspace, which only the operator can reach, so a brief conversation is not
   * told it and the log is.
   */
  const hand = async (attempt, conversation, ws, as, { files, more }, { brief, turnNo }) => {
    const mention = (text) => brief
      ? log(`turn ${turnNo}: ${text} — not said in ${where(conversation)}, which is brief`)
      : attempt(() => adapter.post(conversation, text, { as }))
    for (const file of files) {
      const path = resolve(ws, file.path)
      if (!existsSync(path)) {
        await mention(`${file.path} is no longer there`)
        continue
      }
      const bytes = statSync(path).size
      if (!adapter.can.upload) {
        await mention(`${file.path} is in the spore's workspace`)
        continue
      }
      if (bytes > adapter.limits.file) {
        await mention(`${file.path} is ${(bytes / 1024 / 1024).toFixed(0)} MB, more than ${adapter.label} takes; it is in the spore's workspace`)
        continue
      }
      await attempt(() => adapter.upload(conversation, { path, mime: file.mime }, file.path, { as }))
    }
    if (more) await mention(leftOut(more))
  }

  /**
   * A `working…` message whose answer is posted below it, or whose message was set aside: removed,
   * or, where the platform will not remove it, edited to say so. The answer is already there, so
   * nothing here can fail the delivery.
   */
  const retire = async (attempt, conversation, note, text, answered) => {
    if (note === null) return
    if (adapter.can.remove) {
      try {
        return await attempt(() => adapter.remove(conversation, note))
      } catch (err) {
        log(`${where(conversation)}: working message ${note} not removed — ${said(err)}`)
      }
    }
    await attempt(() => adapter.edit(conversation, note, text, { for: answered }))
      .catch(err => log(`${where(conversation)}: working message ${note} not marked ${text} — ${said(err)}`))
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
    if (!followed.get(ws)?.conversations.has(keyOf(conversation))) {
      const reason = `${where(conversation)} does not reach this spore through ${botFile}`
      settleOutbox(ws, entry.outboxNo, { refused: reason })
      log(`turn ${entry.turnNo} of ${ws}: refused — ${reason}`)
      forget(ws, mine)
      return true
    }
    const turn = turnsSince(ws, entry.turnNo - 1).ended[0]
    const heard = turn.asked.filter(message => entry.answers.includes(message.inboxNo))
    const brief = briefed.has(keyOf(conversation))
    const askedHere = heard.some(message => message.replyTo)
    const answer = askedHere ? reply(turn, { brief }) : announce({ record: turn.record, asked: heard }, { brief })
    if (brief && !askedHere) log(`turn ${entry.turnNo} answered ${originOf(heard)} — not said in ${where(conversation)}, which is brief`)
    if (brief) unsaid(turn, conversation)
    const answered = Boolean(turn.record.output) || turn.record.stopReason === 'quiet'
    const text = entry.attemptedAt === null ? answer : `${MAY_REPEAT}\n\n${answer}`
    const handed = { files: turn.record.deliverables ?? [], more: turn.record.deliverablesMore ?? 0 }
    const answering = mine.at(-1)?.asked ?? null
    const { name } = followed.get(ws)
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
        await attempt(() => formatted(first, { answering, for: forOf(mine), as: name, turn: { turnNo: entry.turnNo, stopReason: turn.record.stopReason }, origin: askedHere ? null : originOf(heard) }))
        for (const part of rest) await attempt(() => formatted(part, { as: name }))
        await hand(attempt, conversation, ws, name, handed, { brief, turnNo: entry.turnNo })
        for (const note of mine) {
          await retire(attempt, conversation, await noteOf(note), ANSWERED, forOf([note]))
          if (note.taken) await mark(attempt, conversation, note.asked, () => [answered ? null : reactionsOf(adapter, botFile).failed, note.taken])
        }
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

  /** How a turn ended, logged for the operator where a brief conversation is not told it. */
  const unsaid = (turn, conversation) => {
    const ending = endingOf(turn.record)
    if (ending) log(`turn ${turn.record.turnNo} ended ${ending} — not said in ${where(conversation)}, which is brief`)
  }

  const tellWaiting = async (attempt, entry, text, as) => {
    const note = await noteOf(entry)
    if (note === null) return attempt(() => adapter.post(entry.conversation, text, { as, for: forOf([entry]) }))
    try {
      await attempt(() => adapter.edit(entry.conversation, note, text, { for: forOf([entry]) }))
    } catch (err) {
      if (err.retryable) throw err
      log(`${where(entry.conversation)}: working message ${note} cannot be edited (${said(err)}), saying it anew`)
      await attempt(() => adapter.post(entry.conversation, text, { as, for: forOf([entry]) }))
    }
  }

  const onTurn = async (ws, turn) => {
    clearTimeout(shown.get(ws)?.timer)
    shown.delete(ws)

    const read = new Set(turn.asked.map(entry => entry.inboxNo))
    const left = (state.pending[ws] ?? []).filter(entry => !read.has(entry.inbox))
    if (left.length && stateOf(ws).state !== RUNNING) {
      const { name } = followed.get(ws)
      const work = left.map(entry => {
        const brief = briefed.has(keyOf(entry.conversation))
        if (brief) unsaid(turn, entry.conversation)
        return delivery.to(entry.conversation, attempt => tellWaiting(attempt, entry, waiting(turn, { brief }), name))
      })
      for (const outcome of await Promise.allSettled(work)) {
        if (outcome.status === 'rejected') log(`turn ${turn.record.turnNo} of ${ws}: not told it is waiting — ${said(outcome.reason)}`)
      }
    }

    const owed = await drain(ws)
    if (owed) forget(ws, (state.pending[ws] ?? []).filter(note => read.has(note.inbox) && !owed.has(note.inbox)))
    if (turn.record.stopReason === 'quiet' && adapter.quiet) await tellQuiet(ws, turn)
  }

  /**
   * A quiet turn that read what nobody in a conversation said — a schedule, a webhook, a job — told
   * to an adapter that shows one, in the spore's `replyTo` default where that is this bot's: the
   * core owes no conversation an answer for it, so nothing else reaches one.
   */
  const tellQuiet = async (ws, turn) => {
    const unprompted = turn.asked.filter(message => !message.replyTo)
    if (!unprompted.length) return
    const { name, conversations } = followed.get(ws)
    const place = readConfig(configFile).replyTo?.[name]
    if (!place?.startsWith(prefix)) return
    const conversation = place.slice(prefix.length)
    if (!conversations.has(keyOf(conversation))) return
    await delivery.to(conversation, attempt => attempt(() => adapter.quiet(conversation, { turnNo: turn.record.turnNo, origin: originOf(unprompted) })))
      .catch(err => log(`turn ${turn.record.turnNo} of ${ws}: its quiet end not shown in ${where(conversation)} — ${said(err)}`))
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

  /** What the platform readies before anyone writes — Discord's roles and webhooks — for every conversation the bot file names. */
  const prepare = async () => {
    let table
    try {
      table = routesOf(adapter, botFile)
    } catch (err) {
      return log(`bot file: ${said(err)}`)
    }
    await adapter.prepare(table, log)
  }

  const run = async (signal) => {
    signal.addEventListener('abort', () => stopping.abort(), { once: true })
    const failed = []
    const halt = (err) => {
      failed.push(err)
      stopping.abort()
    }
    const typing = adapter.can.typing ? setInterval(type, typingEveryMs) : null
    const approving = setInterval(approvals.pass, approveEveryMs)
    if (adapter.prepare) await prepare()
    await Promise.all([listen().catch(halt), follow().catch(halt)])
    clearInterval(typing)
    clearInterval(approving)
    for (const lines of shown.values()) clearTimeout(lines.timer)
    save()
    if (failed.length) throw failed[0]
  }

  return { run }
}
