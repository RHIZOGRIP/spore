/**
 * The Telegram connector against real spores: the relay's conformance suite with Telegram behind
 * a stand-in Bot API, and what is Telegram's alone.
 */

import './fixtures/own-config.js'
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'

import { conformance } from './fixtures/relay-conformance.js'
import { answers } from './fixtures/scripted-model.js'
import { readInbox } from '../src/core/spore-dir.js'
import { SporeError } from '../src/index.js'
import { TELEGRAM, createAdapter } from '@rhizogrip/spore-plugin-telegram/src/adapter.js'

const OPS = { post: 'say', edit: 'revise', remove: 'remove', upload: 'document', react: 'react', typing: 'typing', updates: 'updates' }

const standIn = () => {
  const waiting = []
  const sent = []
  const faults = []
  const delivered = new Map()
  let id = 100
  let wake = null
  const fault = (op) => {
    const found = faults.find(f => f.op === op && f.times > 0)
    if (!found) return
    found.times -= 1
    throw found.error
  }
  return {
    sent,
    delivered,
    lastUpdate: 0,
    lastMessage: 0,
    onPoll: () => {},
    push (update) { waiting.push(update); wake?.() },
    fail: (op, error, times = 1) => faults.push({ op, error, times }),
    async updates (offset, { signal, seconds } = {}) {
      fault('updates')
      this.onPoll(offset)
      if (offset !== undefined) while (waiting.length && waiting[0].update_id < offset) waiting.shift()
      if (!waiting.length && seconds !== 0) {
        await new Promise(resolve => {
          wake = resolve
          signal?.addEventListener('abort', resolve, { once: true })
        })
        wake = null
        if (signal?.aborted) throw new Error('aborted')
      }
      return [...waiting]
    },
    say: async (chat, text, { answering = null, html = false } = {}) => {
      fault('say')
      id += 1
      sent.push({ op: 'say', chat, text, message: id, answering, html })
      return { message_id: id }
    },
    revise: async (chat, message, text) => {
      fault('revise')
      sent.push({ op: 'revise', chat, message, text })
      return true
    },
    remove: async (chat, message) => {
      fault('remove')
      sent.push({ op: 'remove', chat, message })
      return true
    },
    document: async (chat, file, caption) => {
      fault('document')
      sent.push({ op: 'document', chat, path: file.path, caption })
      return {}
    },
    react: async (chat, message, emoji) => {
      fault('react')
      sent.push({ op: 'react', chat, message, emoji })
      return true
    },
    typing: async (chat) => {
      fault('typing')
      sent.push({ op: 'typing', chat })
      return true
    },
    me: async () => ({ username: 'sporebot' })
  }
}

const said = (one) => {
  if (one.op === 'say') return { op: 'post', note: one.message, text: one.text, answering: one.answering, formatted: one.html }
  if (one.op === 'revise') return { op: 'edit', note: one.message, text: one.text }
  if (one.op === 'remove') return { op: 'remove', note: one.message }
  if (one.op === 'react') return { op: 'react', message: one.message, emoji: one.emoji }
  if (one.op === 'typing') return { op: 'typing' }
  return { op: 'upload', path: one.path, caption: one.caption }
}

const harness = {
  spec: TELEGRAM,
  words: (text) => text,
  formats: true,
  credentials: { TRIAGE_BOT_TOKEN: 'the-bot-token', OTHER_BOT_TOKEN: 'another-bot-token' },
  botFile: (bot, table, fields = {}) => ({
    token: `\${${bot.toUpperCase()}_BOT_TOKEN}`,
    chats: Object.fromEntries(Object.entries(table).map(([chat, { spore, details, show }]) =>
      [chat, details || show ? { spore, ...(details ? { details } : {}), ...(show ? { show } : {}) } : spore])),
    ...fields
  }),
  platform: standIn,
  adapter: (telegram, bot) => createAdapter({ telegram, bot }),
  say (telegram, { conversation, text, files = 0, id, shared = false }) {
    const update = id === undefined
      ? {
          update_id: ++telegram.lastUpdate,
          message: {
            message_id: ++telegram.lastMessage,
            chat: shared ? { id: Number(conversation), type: 'group', title: `group ${conversation}` } : { id: Number(conversation), type: 'private' },
            from: { id: Number(conversation), first_name: `U${conversation}`, username: `u${conversation}` },
            ...(text === null ? {} : files ? { caption: text } : { text }),
            ...(files ? { photo: [{ file_id: 'p' }] } : {})
          }
        }
      : telegram.delivered.get(id)
    telegram.delivered.set(update.update_id, update)
    telegram.push(update)
    return {
      id: update.update_id,
      message: update.message.message_id,
      from: { name: `U${conversation} (@u${conversation})`, id: `telegram:${conversation}`, where: shared ? `the Telegram group "group ${conversation}"` : 'a private chat on Telegram' }
    }
  },
  seen: (telegram, conversation) => telegram.sent.filter(one => String(one.chat) === conversation).map(said),
  fail: (telegram, op, error, times) => telegram.fail(OPS[op], error, times),
  retryable: (retryAfter) => new SporeError('telegram failed', { type: 'TELEGRAM_FAILED', retryable: true, detail: 'Too Many Requests', context: { status: 429, retryAfter } }),
  refused: (detail) => new SporeError('telegram failed', { type: 'TELEGRAM_FAILED', retryable: false, detail, context: { status: 400, retryAfter: null } }),
  command: (verb, args) => `/${verb}${args ? ` ${args}` : ''}`
}

conformance(harness, (ctx) => {
  describe('on Telegram', () => {
    it('confirms an update only once the spore has it', async () => {
      const seen = []
      ctx.platform.onPoll = (offset) => seen.push({ offset, inbox: readInbox(ctx.ws).length })
      ctx.start()
      const asked = ctx.say({ conversation: '1', text: 'hello' })
      await ctx.until(() => seen.some(poll => poll.offset === asked.id + 1))
      expect(seen.find(poll => poll.offset === asked.id + 1).inbox).toBe(1)
    })

    it('never takes another bot\'s message that has the same update id for one already said', async () => {
      ctx.routes({ 1: { spore: 'triage' } }, { 2: { spore: 'triage' } })
      const other = standIn()
      ctx.start()
      ctx.start({ adapter: harness.adapter(other, 'other'), botFile: join(ctx.root, 'telegram', 'other.json'), statePath: join(ctx.root, 'state', 'other.json') })
      ctx.say({ conversation: '1', text: 'from the first bot' })
      await ctx.until(() => ctx.posted('1', 'hello back'))
      harness.say(other, { conversation: '2', text: 'from the second bot' })
      await ctx.until(() => harness.seen(other, '2').some(one => one.op === 'post' && one.text === 'hello back'))
      expect(readInbox(ctx.ws).map(entry => [entry.text, entry.requestId])).toEqual([
        ['from the first bot', 'telegram:triage:1'],
        ['from the second bot', 'telegram:other:1']
      ])
    })

    it('sends an answer in Telegram\'s HTML, and as plain text when Telegram refuses the formatting', async () => {
      let release
      const gate = new Promise(resolve => { release = resolve })
      ctx.replying(async () => { await gate; return answers('**first**') })
      ctx.start()
      ctx.say({ conversation: '1', text: 'hello' })
      await ctx.until(() => ctx.posts('1').length === 1)
      ctx.platform.fail('say', Object.assign(harness.refused('Bad Request: can\'t parse entities: unsupported start tag'), { context: { status: 400, retryAfter: null } }))
      release()
      await ctx.until(() => ctx.posted('1', '**first**'))
      expect(ctx.logs.some(line => /refused the formatting/.test(line))).toBe(true)
      expect(ctx.posts('1').find(one => one.text === '**first**').formatted).toBe(false)
    })

    it('refuses to share a bot with another process', async () => {
      ctx.platform.fail('updates', Object.assign(harness.refused('Conflict: terminated by other getUpdates request'), { context: { status: 409, retryAfter: null } }))
      const handle = ctx.start()
      await expect(handle.done).rejects.toMatchObject({ type: 'TELEGRAM_CONFLICT' })
    })
  })
})
