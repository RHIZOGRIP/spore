/**
 * The Discord connector against real spores: the relay's conformance suite with Discord behind a
 * stand-in Gateway and REST, and what is Discord's alone — roles, webhooks, several spores in a
 * channel, and spores talking to each other.
 */

import './fixtures/own-config.js'
import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { conformance } from './fixtures/relay-conformance.js'
import { withAuth } from './fixtures/outside-ws.js'
import { definitionWith } from '../src/testing.js'
import { readInbox } from '../src/core/spore-dir.js'
import { send } from '../src/core/send.js'
import { RUNNING, stateOf, stop } from '../src/core/state.js'
import { SporeError } from '../src/index.js'
import { download } from '../src/relay/download.js'
import { DISCORD, createAdapter } from '@rhizogrip/spore-plugin-discord/src/adapter.js'

const ROLES = { triage: '701', ledger: '702' }
const OPS = { post: 'post', edit: 'revise', remove: 'remove', upload: 'upload', react: 'react', typing: 'typing', fetch: 'download' }
const HEADER = /^(<@\d+> ↪ "[^\n]*"\n)+/

const standIn = () => {
  const sent = []
  const faults = []
  const created = []
  const delivered = new Map()
  const lastSaid = new Map()
  const stored = new Map()
  let handle = null
  let log = null
  let handled = Promise.resolve()
  let waiting = []
  let next = 5000
  const fault = (op) => {
    const found = faults.find(f => f.op === op && f.times > 0)
    if (!found) return
    found.times -= 1
    throw found.error
  }
  const channelOf = (hook) => hook.id.slice('hook-'.length)
  const deliver = (d) => {
    delivered.set(d.id, d)
    if (!d.webhook_id) lastSaid.set(`${d.channel_id}/${d.author.id}`, d.id)
    if (!handle) return waiting.push(d)
    handled = handled.then(() => handle(d)).catch(err => log(`message ${d.id}: ${err.message}`))
  }
  return {
    sent,
    created,
    delivered,
    stored,
    deliver,
    next: () => String(++next),
    fail: (op, error, times = 1) => faults.push({ op, error, times }),
    download: async (url, { most }) => {
      fault('download')
      return download(url, { most, fetchImpl: async () => new Response(stored.get(url)) })
    },
    channel: async (id) => ({ id, guild_id: 'g1', name: `chan-${id}` }),
    roles: async () => created.map(name => ({ id: ROLES[name], name })),
    createRole: async (guild, name) => {
      created.push(name)
      return { id: ROLES[name] }
    },
    webhooks: async () => [],
    createWebhook: async (channel) => ({ id: `hook-${channel}`, token: 'hook-token' }),
    post: async (hook, payload) => {
      fault('post')
      const channel = channelOf(hook)
      const answering = payload.allowed_mentions.users?.length ? lastSaid.get(`${channel}/${payload.allowed_mentions.users.at(-1)}`) : null
      const id = String(++next)
      sent.push({ op: 'post', channel, id, answering, ...payload })
      return { id }
    },
    revise: async (hook, message, payload) => {
      fault('revise')
      sent.push({ op: 'revise', channel: channelOf(hook), id: message, ...payload })
    },
    remove: async (hook, message) => {
      fault('remove')
      sent.push({ op: 'remove', channel: channelOf(hook), id: message })
    },
    upload: async (hook, payload, files) => {
      fault('upload')
      sent.push({ op: 'upload', channel: channelOf(hook), ...payload, files })
    },
    typing: async (channel) => {
      fault('typing')
      sent.push({ op: 'typing', channel })
    },
    react: async (channel, message, emoji) => {
      fault('react')
      sent.push({ op: 'react', channel, message, emoji })
    },
    unreact: async (channel, message, emoji) => {
      fault('react')
      sent.push({ op: 'unreact', channel, message, emoji })
    },
    connect: ({ onMessage, signal, log: logged }) => {
      handle = onMessage
      log = logged
      for (const d of waiting) handled = handled.then(() => handle(d)).catch(err => log(`message ${d.id}: ${err.message}`))
      waiting = []
      return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    }
  }
}

const said = (discord, { channel, author, content, roles = [], files = [], webhook, username, replyingTo = null }) => {
  const attachments = files.map(({ name, mime, data }) => {
    const url = `https://cdn.example/attachments/${discord.next()}/${name}?ex=1&is=1&hm=1`
    discord.stored.set(url, data)
    return { filename: name, content_type: mime, size: data.length, url }
  })
  const d = {
    id: discord.next(),
    channel_id: channel,
    guild_id: 'g1',
    author: { id: author, username: username ?? `u${author}` },
    member: webhook ? undefined : { roles: [], nick: `U${author}` },
    content,
    mention_roles: roles,
    attachments,
    webhook_id: webhook,
    referenced_message: replyingTo
  }
  discord.deliver(d)
  return d
}

const seen = (discord, conversation) => {
  const ops = discord.sent.filter(one => one.channel === conversation)
  const out = []
  for (let i = 0; i < ops.length; i++) {
    const one = ops[i]
    const text = (content) => content.replace(HEADER, '')
    if (one.op === 'post') out.push({ op: 'post', note: one.id, text: text(one.content), answering: one.answering, formatted: false, as: one.username ?? null })
    else if (one.op === 'revise') out.push({ op: 'edit', note: one.id, text: text(one.content) })
    else if (one.op === 'remove') out.push({ op: 'remove', note: one.id })
    else if (one.op === 'upload') out.push({ op: 'upload', path: one.files[0].path, caption: one.content })
    else if (one.op === 'typing') out.push({ op: 'typing' })
    else if (one.op === 'react') out.push({ op: 'react', message: one.message, emoji: one.emoji })
    else if (ops[i + 1]?.op === 'react' && ops[i + 1].message === one.message) {
      out.push({ op: 'react', message: one.message, emoji: ops[i + 1].emoji })
      i += 1
    } else out.push({ op: 'react', message: one.message, emoji: null })
  }
  return out
}

const harness = {
  spec: DISCORD,
  credentials: { DISCORD_BOT_TOKEN: 'the-bot-token', OTHER_BOT_TOKEN: 'another-bot-token' },
  words: (text) => text.replace(/^@triage ?/, '').replace(/\n\n\[Discord channel [^\n]*\]$/, ''),
  formats: false,
  botFile: (bot, table, fields = {}) => ({
    token: bot === 'triage' ? '${DISCORD_BOT_TOKEN}' : '${OTHER_BOT_TOKEN}', // eslint-disable-line no-template-curly-in-string
    channels: Object.fromEntries(Object.entries(table).map(([channel, { spore, details, show, brief, people = [`9${channel}`, '*'] }]) =>
      [channel, { spores: [spore], people, ...(details ? { details } : {}), ...(show ? { show } : {}), ...(brief !== undefined ? { brief } : {}) }])),
    ...fields
  }),
  shared: (n) => String(n),
  platform: standIn,
  adapter: (discord, bot, botFile) => createAdapter({ discord, me: { id: '900', username: 'sporebot' }, botFile }),
  say (discord, { conversation, text, files = [], id, person = `9${conversation}` }) {
    const d = id === undefined
      ? said(discord, { channel: conversation, author: person, content: text === null ? `<@&${ROLES.triage}>` : `<@&${ROLES.triage}> ${text}`, roles: [ROLES.triage], files })
      : discord.delivered.get(id)
    if (id !== undefined) discord.deliver(d)
    return {
      id: d.id,
      message: d.id,
      from: { name: `U${person}`, id: `discord:${person}`, where: `the Discord channel "#chan-${conversation}"` }
    }
  },
  seen,
  fail: (discord, op, error, times) => discord.fail(OPS[op], error, times),
  retryable: (retryAfter) => new SporeError('discord failed', { type: 'DISCORD_FAILED', retryable: true, detail: 'You are being rate limited.', context: { status: 429, code: null, retryAfter } }),
  refused: (detail) => new SporeError('discord failed', { type: 'DISCORD_FAILED', retryable: false, detail, context: { status: 403, code: null, retryAfter: null } }),
  command: (verb, args) => `${verb}${args ? ` ${args}` : ''}`
}

conformance(harness, (ctx) => {
  describe('on Discord', () => {
    const ALICE = '41'
    const BOB = '42'
    const CHANNEL = '100'
    const ledger = () => join(ctx.root, 'home', 'ledger')

    const channel = (entry, fields = {}) => {
      mkdirSync(ledger(), { recursive: true })
      writeFileSync(join(ledger(), 'spore.cmk'), withAuth(definitionWith('anthropic/claude-haiku-4-5')))
      writeFileSync(join(ctx.root, 'discord', 'triage.json'), JSON.stringify({ token: '${DISCORD_BOT_TOKEN}', channels: { [CHANNEL]: entry }, ...fields })) // eslint-disable-line no-template-curly-in-string
    }
    const posts = () => ctx.platform.sent.filter(one => one.op === 'post')
    const answered = (count) => posts().filter(one => one.content.endsWith('hello back')).length === count
    const write = (fields) => said(ctx.platform, { channel: CHANNEL, author: ALICE, ...fields })

    afterEach(async () => {
      if (stateOf(ledger()).state === RUNNING) stop(ledger())
      await ctx.until(() => stateOf(ledger()).state !== RUNNING, 20_000)
    })

    it('has its spores\' roles and its webhook as soon as the service starts, before anyone writes', async () => {
      channel({ spores: ['triage', 'ledger'], people: [ALICE] })
      ctx.start()
      await ctx.until(() => ctx.platform.created.length === 2)
      expect(ctx.platform.created.sort()).toEqual(['ledger', 'triage'])
      expect(ctx.platform.sent).toEqual([])
    })

    it('reaches the spore its role names, which answers under its own name, opened with whom it answers and pinging them', async () => {
      channel({ spores: ['triage', 'ledger'], people: [ALICE] })
      ctx.start()
      write({ content: `<@&${ROLES.triage}> can you check the payouts`, roles: [ROLES.triage] })
      await ctx.until(() => answered(1))
      const [working, answer] = posts()
      expect(working).toMatchObject({ username: 'triage', content: `<@${ALICE}> ↪ "@triage can you check the payouts"\nworking…`, allowed_mentions: { parse: [], users: [] } })
      expect(answer).toMatchObject({ username: 'triage', content: `<@${ALICE}> ↪ "@triage can you check the payouts"\nhello back`, allowed_mentions: { parse: [], users: [ALICE] } })
      await ctx.until(() => ctx.platform.sent.some(one => one.op === 'remove' && one.id === working.id))
      expect(readInbox(ctx.ws)[0]).toMatchObject({ fromName: `U${ALICE}`, fromId: `discord:${ALICE}`, fromWhere: `the Discord channel "#chan-${CHANNEL}"`, replyTo: `discord:triage/${CHANNEL}` })
      expect(readInbox(ctx.ws)[0].text).toMatch(/^@triage can you check the payouts\n\n\[Discord channel 100, message \d+\. Nothing else said here since you last spoke — "\$SPORE_DISCORD" history 100 --before \d+ reads what was said before\.\]$/)
      expect(readInbox(ledger())).toEqual([])
    })

    it('shows each spore with the avatar the bot file gives it, and Discord\'s own for one it does not', async () => {
      channel({ spores: ['triage', 'ledger'], people: [ALICE] }, { avatars: { triage: 'https://forge.example/triage.png' } })
      ctx.start()
      write({ content: `<@&${ROLES.triage}> <@&${ROLES.ledger}> one word each`, roles: [ROLES.triage, ROLES.ledger] })
      await ctx.until(() => answered(2))
      for (const post of posts().filter(one => one.username === 'triage')) expect(post.avatar_url).toBe('https://forge.example/triage.png')
      for (const post of posts().filter(one => one.username === 'ledger')) expect(post).not.toHaveProperty('avatar_url')
    })

    it('reaches no spore when it names none, and none when its author may not address them', async () => {
      channel({ spores: ['triage', 'ledger'], people: [ALICE] })
      ctx.start()
      write({ content: 'morning all' })
      write({ author: BOB, content: `<@&${ROLES.triage}> hi`, roles: [ROLES.triage] })
      await ctx.until(() => ctx.logs.some(line => line.startsWith('refused')))
      expect(ctx.logs).toContain(`refused U${BOB} (${BOB}) in channel ${CHANNEL} — to allow them, add "${BOB}" to its people in ${join(ctx.root, 'discord', 'triage.json')}`)
      expect(readInbox(ctx.ws)).toEqual([])
      expect(ctx.platform.sent).toEqual([])
    })

    it('reaches the spore whose post it replies to, and counts what was said meanwhile', async () => {
      channel({ spores: ['triage', 'ledger'], people: [ALICE] })
      ctx.start()
      write({ content: `<@&${ROLES.triage}> first`, roles: [ROLES.triage] })
      await ctx.until(() => answered(1))
      await ctx.idle(1)
      const answer = posts().find(one => one.content.endsWith('hello back'))
      write({ author: 'hook', webhook: `hook-${CHANNEL}`, username: 'triage', content: answer.content })
      write({ content: 'an aside' })
      write({ content: 'thanks — and the totals?', replyingTo: { webhook_id: `hook-${CHANNEL}`, author: { username: 'triage' } } })
      await ctx.idle(2)
      expect(readInbox(ctx.ws).at(-1).text).toMatch(/^thanks — and the totals\?\n\n\[Discord channel 100, message \d+\. 1 earlier message here since you last spoke/)
    })

    it('leaves a spore\'s post to the others alone unless the channel lets spores talk, and never to itself', async () => {
      channel({ spores: ['triage', 'ledger'], people: [ALICE] })
      ctx.start()
      write({ author: 'hook', webhook: `hook-${CHANNEL}`, username: 'triage', content: `<@&${ROLES.ledger}> totals?`, roles: [ROLES.ledger] })
      await ctx.until(() => ctx.platform.created.length === 2)
      expect(readInbox(ledger())).toEqual([])

      channel({ spores: ['triage', 'ledger'], people: [ALICE], sporesTalk: true })
      write({ author: 'hook', webhook: `hook-${CHANNEL}`, username: 'triage', content: `<@&${ROLES.ledger}> <@&${ROLES.triage}> totals?`, roles: [ROLES.ledger, ROLES.triage] })
      await ctx.until(() => readInbox(ledger()).length === 1)
      expect(readInbox(ledger())[0]).toMatchObject({ fromName: 'triage (spore)' })
      expect(readInbox(ctx.ws)).toEqual([])
    })

    it('posts a turn nobody in the channel started under the spore\'s name, pinging no one', async () => {
      channel({ spores: ['triage'], people: [ALICE] })
      ctx.defaultReplyTo(CHANNEL)
      ctx.start()
      await ctx.until(() => ctx.platform.created.length === 1)
      send(ctx.ws, 'Check.', { schedule: { name: 'digest', due: '2026-10-07T07:00:00Z' }, env: ctx.env })
      await ctx.until(() => posts().some(one => one.content === 'schedule "digest"\n\nhello back'))
      expect(posts()[0]).toMatchObject({ username: 'triage', allowed_mentions: { parse: [], users: [] } })
    })
  })
})
