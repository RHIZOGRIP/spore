import { existsSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import { CONFIG_FILE, databaseOf, isWorkspace, lastEventSeq, loadEnvironment, outbox, readConfig, RUNNING, send, settleOutbox, stateOf, turnsSince, watchAll, workspaceFor } from '@rhizogrip/spore'
import { avatarsOf, channelsOf } from './bots.js'
import { createDelivery } from './delivery.js'
import { announce, header, isWorkingPost, pieces, plain, reply, waiting, workingPost } from './forward.js'
import { loadState, saveState } from './state.js'

const MAX_FILE = 20 * 1024 * 1024
const leftOut = (more) => `and ${more} more file${more === 1 ? '' : 's'} in data/out/, in the spore's workspace`
const HOOK_NAME = 'spore'
const NOBODY = { parse: [] }
const unpassed = (count, spores) => `only text reaches a spore for now: your ${count === 1 ? 'file' : `${count} files`} did not reach ${spores.join(' or ')}`

const pause = (ms, signal) => new Promise(resolve => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

const said = (err) => [err.message, err.detail].filter(Boolean).join(' — ')

/**
 * One bot, its channels in `botFile`, signed in as `me`. Each channel holds people and spores; a
 * message reaches the spores it addresses — by their role, or by replying to one's post — and
 * each spore answers under its own name through the channel's webhook. `env` is the environment
 * the service was started with; `environment` beside `config.json` is read again for every turn.
 */
export function createService ({ discord, me, botFile, statePath, env, log, configFile = CONFIG_FILE, sleep = pause, followEveryMs = 1000 }) {
  const replyTo = `discord:${basename(botFile, '.json')}/`
  const sendEnv = () => {
    const fresh = { ...env }
    loadEnvironment(configFile, fresh)
    return fresh
  }
  const state = loadState(statePath)
  const stopping = new AbortController()
  const delivery = createDelivery({ sleep: (ms) => sleep(ms, stopping.signal), signal: stopping.signal })
  const notes = new WeakMap()
  let followed = new Map()
  let routeFailure = null
  let avatars = {}

  const save = () => saveState(statePath, state)
  const noteOf = (entry) => notes.get(entry) ?? Promise.resolve(entry.note)

  const route = () => {
    const read = { config: readConfig(configFile), channels: channelsOf(botFile) }
    avatars = avatarsOf(botFile)
    return read
  }
  const as = (name) => ({ username: name, ...(avatars[name] ? { avatar_url: avatars[name] } : {}) })
  const sporeOf = (name, config) => {
    const ws = workspaceFor(name, { config }).path
    return isWorkspace(ws) ? ws : null
  }

  const hookOf = async (channel) => {
    if (!state.hooks[channel]) {
      const own = (await discord.webhooks(channel)).find(hook => hook.user?.id === me.id && hook.token)
      const hook = own ?? await discord.createWebhook(channel, HOOK_NAME)
      state.hooks[channel] = { id: hook.id, token: hook.token }
      save()
    }
    return state.hooks[channel]
  }

  const rolesOf = async (guild, spores) => {
    const known = (state.roles[guild] ??= {})
    const missing = spores.filter(spore => !known[spore])
    if (missing.length) {
      const roles = await discord.roles(guild)
      for (const spore of missing) known[spore] = (roles.find(role => role.name === spore) ?? await discord.createRole(guild, spore)).id
      save()
    }
    return known
  }

  const heard = (channel, spores, speaker) => {
    const counts = (state.unheard[channel] ??= {})
    for (const spore of spores) counts[spore] = spore === speaker ? 0 : (counts[spore] ?? 0) + 1
    save()
  }

  const allowed = (message, humans) =>
    humans.includes(message.author.id) || (message.member?.roles ?? []).some(role => humans.includes(`role:${role}`))

  const tell = (hook, channel, name, content) => delivery.to(channel, attempt => attempt(() => discord.post(hook, { ...as(name), content, allowed_mentions: NOBODY })))
    .catch(err => log(`channel ${channel}: not told — ${said(err)}`))

  const follows = (ws) => {
    if (state.cursors[ws]) return false
    state.cursors[ws] = { seq: lastEventSeq(ws), turn: stateOf(ws).lastTurnNo, database: databaseOf(ws) }
    return true
  }

  const pass = async ({ name, config, message, text, quote, hook }) => {
    const channel = message.channel_id
    const opening = header(message.author.id, quote)
    let ws
    try {
      ws = sporeOf(name, config)
    } catch (err) {
      log(`channel ${channel}: "${name}" — ${said(err)}`)
      return tell(hook, channel, name, `${opening}\nthis channel names "${name}", which is not a spore name — tell whoever runs me`)
    }
    if (!ws) {
      log(`channel ${channel}: no spore "${name}"`)
      return tell(hook, channel, name, `${opening}\nthere is no spore called "${name}" — tell whoever runs me`)
    }
    if (follows(ws)) save()

    const before = state.unheard[channel][name] - 1
    const pointer = `[Discord channel ${channel}, message ${message.id}. ${before > 0 ? `${before} earlier message${before > 1 ? 's' : ''} here since you last spoke` : 'Nothing else said here since you last spoke'} — "$SPORE_DISCORD" history ${channel} --before ${message.id} reads what was said before.]`
    let sent
    try {
      sent = send(ws, `${text}\n\n${pointer}`, { requestId: `discord:${message.id}:${name}`, replyTo: `${replyTo}${channel}`, env: sendEnv() })
    } catch (err) {
      log(`channel ${channel}: send to ${name} refused — ${err.type} ${said(err)}`)
      return tell(hook, channel, name, `${opening}\n${err.type === 'ADMISSION_FULL' ? 'busy' : 'not delivered'} — ${said(err)}`)
    }
    if (sent.repeated) return log(`channel ${channel}: message ${message.id} was already said to ${name}, as inbox ${sent.inbox}`)

    const entry = { inbox: sent.inbox, channel, asker: message.author.id, said: quote, note: null }
    ;(state.pending[ws] ??= []).push(entry)
    save()
    notes.set(entry, delivery.to(channel, attempt => attempt(() => discord.post(hook, { ...as(name), content: workingPost(opening, sent.started), allowed_mentions: NOBODY })))
      .then(post => post.id, err => {
        log(`channel ${channel}: no working post — ${said(err)}`)
        return null
      })
      .then(note => {
        entry.note = note
        save()
        return note
      }))
  }

  const handle = async (message) => {
    if (message.author.id === me.id) return
    let read
    try {
      read = route()
    } catch (err) {
      return log(`message ${message.id}: the bot file is unreadable — ${said(err)}`)
    }
    const channel = read.channels.get(message.channel_id)
    if (!channel) return

    state.guilds[message.channel_id] = message.guild_id
    const roles = await rolesOf(message.guild_id, channel.spores)
    const hook = await hookOf(message.channel_id)
    const ownPost = message.webhook_id === hook.id
    if (message.webhook_id && !ownPost) return
    if (ownPost && isWorkingPost(message.content)) return
    const speaker = ownPost ? message.author.username : null
    heard(message.channel_id, channel.spores, speaker)
    if (ownPost && !channel.sporesTalk) return

    const repliedTo = message.referenced_message?.webhook_id === hook.id ? message.referenced_message.author.username : null
    const addressed = channel.spores.filter(spore => spore !== speaker && (message.mention_roles.includes(roles[spore]) || spore === repliedTo))
    if (!addressed.length) return
    if (!ownPost && !allowed(message, channel.humans)) {
      return log(`refused ${message.author.username} (${message.author.id}) in channel ${message.channel_id} — to allow them, add "${message.author.id}" to its humans in ${botFile}`)
    }

    const quote = plain(message.content, roles)
    const who = ownPost ? `${speaker} (spore)` : message.member?.nick ?? message.author.global_name ?? message.author.username
    for (const name of addressed) await pass({ name, config: read.config, message, text: `${who}, in Discord:\n${quote}`, quote, hook })
    if (message.attachments.length) tell(hook, message.channel_id, addressed[0], `${header(message.author.id, quote)}\n${unpassed(message.attachments.length, addressed)}`)
  }

  const listen = () => discord.connect({
    onMessage: handle,
    onReady: (ready) => log(`connected to Discord as ${ready.user.username}`),
    signal: stopping.signal,
    log,
    sleep: (ms) => sleep(ms, stopping.signal)
  })

  /** Each channel's spores given their roles, and the channel its webhook, before anyone writes there. */
  const prepare = async () => {
    let read
    try {
      read = route()
    } catch (err) {
      return log(`bot file: ${said(err)}`)
    }
    for (const [channel, { spores: names }] of read.channels) {
      try {
        state.guilds[channel] ??= (await discord.channel(channel)).guild_id
        await rolesOf(state.guilds[channel], names)
        await hookOf(channel)
      } catch (err) {
        log(`channel ${channel}: not ready — ${said(err)}`)
      }
    }
    save()
  }

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
    const next = new Map()
    for (const [channel, { spores: names }] of read.channels) {
      for (const name of names) {
        let ws
        try {
          ws = sporeOf(name, read.config)
        } catch {
          // Told to the channel, and logged, when someone addresses it.
          continue
        }
        if (!ws) continue
        const entry = next.get(ws) ?? { name, channels: new Set() }
        entry.channels.add(channel)
        next.set(ws, entry)
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

  const forget = (ws, gone) => {
    const kept = (state.pending[ws] ?? []).filter(note => !gone.includes(note))
    if (kept.length) state.pending[ws] = kept
    else delete state.pending[ws]
    save()
  }

  const hand = async (attempt, hook, name, ws, { files, more }) => {
    for (const file of files) {
      const path = resolve(ws, file.path)
      if (!existsSync(path)) {
        await attempt(() => discord.post(hook, { ...as(name), content: `${file.path} is no longer there`, allowed_mentions: NOBODY }))
        continue
      }
      const bytes = statSync(path).size
      if (bytes > MAX_FILE) {
        await attempt(() => discord.post(hook, { ...as(name), content: `${file.path} is ${(bytes / 1024 / 1024).toFixed(0)} MB, more than Discord takes; it is in the spore's workspace`, allowed_mentions: NOBODY }))
        continue
      }
      await attempt(() => discord.upload(hook, { ...as(name), content: file.path, allowed_mentions: NOBODY }, [{ path, mime: file.mime }]))
    }
    if (more) await attempt(() => discord.post(hook, { ...as(name), content: leftOut(more), allowed_mentions: NOBODY }))
  }

  /**
   * One outbox entry of this bot's posted to its channel under the spore's name — opened with whom
   * it answers, pinging them — and its `working…` posts removed; then settled: delivered once
   * Discord took it, refused when the channel does not hold the spore in this bot's file or Discord
   * will not take it. One Discord still did not take when its retries ran out stays pending for
   * the next pass. True when it is settled.
   */
  const deliver = async (ws, entry) => {
    const channel = entry.recipient.slice(replyTo.length)
    const spore = followed.get(ws)
    const mine = (state.pending[ws] ?? []).filter(note => note.channel === channel && entry.answers.includes(note.inbox))
    if (!spore.channels.has(channel)) {
      const reason = `channel ${channel} does not hold ${spore.name} in ${botFile}`
      settleOutbox(ws, entry.outboxNo, { refused: reason })
      log(`turn ${entry.turnNo} of ${ws}: refused — ${reason}`)
      forget(ws, mine)
      return true
    }
    const turn = turnsSince(ws, entry.turnNo - 1).ended[0]
    const asked = turn.asked.filter(message => entry.answers.includes(message.inboxNo))
    const text = asked.some(message => message.replyTo) ? reply(turn) : announce({ record: turn.record, asked })
    const opening = mine.map(note => header(note.asker, note.said)).join('\n')
    const askers = [...new Set(mine.map(note => note.asker))]
    const handed = { files: turn.record.deliverables ?? [], more: turn.record.deliverablesMore ?? 0 }
    try {
      const hook = await hookOf(channel)
      await delivery.to(channel, async (attempt) => {
        for (const part of pieces(opening ? `${opening}\n${text}` : text)) {
          await attempt(() => discord.post(hook, { ...as(spore.name), content: part, allowed_mentions: { parse: [], users: askers } }))
        }
        await hand(attempt, hook, spore.name, ws, handed)
        for (const note of mine) {
          const message = await noteOf(note)
          if (message === null) continue
          await attempt(() => discord.remove(hook, message)).catch(err => log(`channel ${channel}: working post ${message} not removed — ${said(err)}`))
        }
      })
    } catch (err) {
      if (err.retryable || stopping.signal.aborted) {
        log(`turn ${entry.turnNo} of ${ws}: not delivered to channel ${channel} yet — ${said(err)}`)
        return false
      }
      settleOutbox(ws, entry.outboxNo, { refused: said(err) })
      log(`turn ${entry.turnNo} of ${ws}: channel ${channel} refused it — ${said(err)}`)
      forget(ws, mine)
      return true
    }
    settleOutbox(ws, entry.outboxNo)
    forget(ws, mine)
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
      for (const entry of outbox(ws, { kind: 'discord', state: 'pending' })) {
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
    const read = new Set(turn.asked.map(entry => entry.inboxNo))
    const left = (state.pending[ws] ?? []).filter(entry => !read.has(entry.inbox))
    if (left.length && stateOf(ws).state !== RUNNING) {
      const work = left.map(entry => delivery.to(entry.channel, async (attempt) => {
        const message = await noteOf(entry)
        if (message === null) return
        const hook = await hookOf(entry.channel)
        await attempt(() => discord.revise(hook, message, { content: `${header(entry.asker, entry.said)}\n${waiting(turn)}`, allowed_mentions: NOBODY }))
      }))
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
      if (item.event) continue
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
    await prepare()
    await Promise.all([listen().catch(halt), follow().catch(halt)])
    save()
    if (failed.length) throw failed[0]
  }

  return { run }
}
