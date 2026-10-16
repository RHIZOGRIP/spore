/**
 * The Telegram connector against real spores: the relay's conformance suite with Telegram behind
 * a stand-in Bot API, and what is Telegram's alone.
 */

import './fixtures/own-config.js'
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'

import { conformance } from './fixtures/relay-conformance.js'
import { answers } from './fixtures/scripted-model.js'
import { approvalOf, outbox, readInbox, readTurns } from '../src/core/spore-dir.js'
import { requestApproval } from '../src/library/verbs.js'
import { SporeError } from '../src/index.js'
import { TELEGRAM, createAdapter } from '@rhizogrip/spore-plugin-telegram/src/adapter.js'

const ME = { id: 900, username: 'sporebot', can_read_all_group_messages: true }
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
    lastQuery: 0,
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
    ask: async (chat, text, keyboard) => {
      fault('ask')
      id += 1
      sent.push({ op: 'ask', chat, message: id, text, keyboard })
      return { message_id: id }
    },
    close: async (chat, message, text) => {
      fault('close')
      sent.push({ op: 'close', chat, message, text })
      return true
    },
    answer: async (query, text) => {
      sent.push({ op: 'answer', query, text })
      return true
    },
    me: async () => ME
  }
}

const said = (one) => {
  if (one.op === 'say') return { op: 'post', note: one.message, text: one.text, answering: one.answering, formatted: one.html }
  if (one.op === 'revise') return { op: 'edit', note: one.message, text: one.text }
  if (one.op === 'remove') return { op: 'remove', note: one.message }
  if (one.op === 'react') return { op: 'react', message: one.message, emoji: one.emoji }
  if (one.op === 'typing') return { op: 'typing' }
  if (one.op === 'ask') return { op: 'ask', note: one.message, text: one.text, choices: one.keyboard.map(([button]) => ({ label: button.text, data: button.callback_data, style: button.style ?? null })) }
  if (one.op === 'close') return { op: 'close', note: one.message, text: one.text }
  return { op: 'upload', path: one.path, caption: one.caption }
}

const harness = {
  spec: TELEGRAM,
  words: (text) => text,
  formats: true,
  credentials: { TRIAGE_BOT_TOKEN: 'the-bot-token', OTHER_BOT_TOKEN: 'another-bot-token' },
  botFile: (bot, table, fields = {}) => {
    const entries = Object.entries(table)
    const people = entries.filter(([, entry]) => !entry.shared).map(([chat, { spore, details, show, brief }]) =>
      [chat, details || show || brief !== undefined ? { spore, ...(details ? { details } : {}), ...(show ? { show } : {}), ...(brief !== undefined ? { brief } : {}) } : spore])
    const groups = entries.filter(([, entry]) => entry.shared).map(([chat, { spore, details, show, brief, people = [`9${-chat}`, '*'], overhear }]) =>
      [chat, { spores: [spore], people, ...(details ? { details } : {}), ...(show ? { show } : {}), ...(brief !== undefined ? { brief } : {}), ...(overhear ? { overhear } : {}) }])
    return { token: `\${${bot.toUpperCase()}_BOT_TOKEN}`, people: Object.fromEntries(people), groups: Object.fromEntries(groups), ...fields }
  },
  shared: (n) => `-${n}`,
  platform: standIn,
  adapter: (telegram, bot) => createAdapter({ telegram, bot, me: ME }),
  say (telegram, { conversation, text, files = 0, id, shared = false, person = shared ? `9${-conversation}` : conversation }) {
    const mention = shared && text !== null && !text.startsWith('/')
    const written = mention ? `@${ME.username} ${text}` : text
    const update = id === undefined
      ? {
          update_id: ++telegram.lastUpdate,
          message: {
            message_id: ++telegram.lastMessage,
            chat: shared ? { id: Number(conversation), type: 'group', title: `group ${conversation}` } : { id: Number(conversation), type: 'private' },
            from: { id: Number(person), first_name: `U${person}`, username: `u${person}` },
            ...(text === null ? {} : files ? { caption: written } : { text: written }),
            ...(mention ? { [files ? 'caption_entities' : 'entities']: [{ type: 'mention', offset: 0, length: ME.username.length + 1 }] } : {}),
            ...(files ? { photo: [{ file_id: 'p' }] } : {})
          }
        }
      : telegram.delivered.get(id)
    telegram.delivered.set(update.update_id, update)
    telegram.push(update)
    return {
      id: update.update_id,
      message: update.message.message_id,
      from: { name: `U${person} (@u${person})`, id: `telegram:${person}`, where: shared ? `the Telegram group "group ${conversation}"` : 'a private chat on Telegram' }
    }
  },
  seen: (telegram, conversation) => telegram.sent.filter(one => String(one.chat) === conversation).map(said),
  press (telegram, { conversation, note, data, person = conversation }) {
    const query = `q${++telegram.lastQuery}`
    const chat = Number(conversation) < 0 ? { id: Number(conversation), type: 'group', title: `group ${conversation}` } : { id: Number(conversation), type: 'private' }
    telegram.push({ update_id: ++telegram.lastUpdate, callback_query: { id: query, from: { id: Number(person), first_name: `U${person}`, username: `u${person}` }, message: { message_id: note, chat }, data } })
    return { acknowledged: () => telegram.sent.find(one => one.op === 'answer' && one.query === query) }
  },
  fail: (telegram, op, error, times) => telegram.fail(OPS[op], error, times),
  retryable: (retryAfter) => new SporeError('telegram failed', { type: 'TELEGRAM_FAILED', retryable: true, detail: 'Too Many Requests', context: { status: 429, retryAfter } }),
  refused: (detail) => new SporeError('telegram failed', { type: 'TELEGRAM_FAILED', retryable: false, detail, context: { status: 400, retryAfter: null } }),
  command: (verb, args) => `/${verb}${args ? ` ${args}` : ''}`
}

conformance(harness, (ctx) => {
  describe('on Telegram', () => {
    const asking = (request) => requestApproval({
      ws: ctx.ws,
      configFile: join(ctx.root, 'config.json'),
      request: { to: 'telegram:triage/1', by: ['1'], options: [{ id: 'yes', label: 'Yes', style: 'positive' }, { id: 'no', label: 'No', style: 'destructive' }, { id: 'later', label: 'Later' }], ...request }
    }).approval

    it('asks an approval in its own HTML where it has some, each choice a button coloured by its style', async () => {
      ctx.start({ approveEveryMs: 50 })
      const id = asking({ body: { telegram: { html: '<b>Ship</b> it?' }, default: { text: 'not this' } } })
      await ctx.until(() => ctx.platform.sent.some(one => one.op === 'ask'))
      const asked = ctx.platform.sent.find(one => one.op === 'ask')
      expect(asked.text).toBe('<b>Ship</b> it?')
      expect(asked.keyboard).toEqual([
        [{ text: 'Yes', callback_data: `ap:${id}:yes`, style: 'success' }],
        [{ text: 'No', callback_data: `ap:${id}:no`, style: 'danger' }],
        [{ text: 'Later', callback_data: `ap:${id}:later` }]
      ])
    })

    it('asks the default body as its text and a line per fact, and refuses a body of its own that is not Telegram\'s', async () => {
      ctx.start({ approveEveryMs: 50 })
      asking({ body: { default: { text: 'Apply **this**?', facts: [['Now', '<82 %>']] } } })
      const wrong = asking({ body: { telegram: { text: 'x' } } })
      await ctx.until(() => ctx.platform.sent.some(one => one.op === 'ask') && approvalOf(ctx.ws, wrong).settledAt)
      expect(ctx.platform.sent.find(one => one.op === 'ask').text).toBe('Apply <b>this</b>?\n\n<b>Now</b>: &lt;82 %&gt;')
      expect(approvalOf(ctx.ws, wrong)).toMatchObject({ state: 'refused', reason: expect.stringMatching(/^a Telegram body is \{ "html"/) })
    })

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

    describe('in a group', () => {
      const GROUP = '-5'
      const write = (message, person = '41') => {
        const update = {
          update_id: ++ctx.platform.lastUpdate,
          message: { message_id: ++ctx.platform.lastMessage, chat: { id: Number(GROUP), type: 'group', title: 'ops' }, from: { id: Number(person), first_name: `U${person}` }, ...message }
        }
        ctx.platform.push(update)
        return update.message
      }
      const mentioning = (text) => ({ text: `@sporebot ${text}`, entities: [{ type: 'mention', offset: 0, length: 9 }] })

      it('reaches the spore only when said to it — a mention, a reply to the bot, a command — and never as a command naming another bot', async () => {
        ctx.routes({ [GROUP]: { spore: 'triage', shared: true } })
        ctx.start()
        write({ text: 'lunch at noon?' })
        write({ text: '/status@otherbot' })
        write(mentioning('what failed?'))
        await ctx.until(() => ctx.posted(GROUP, 'hello back'))
        const answer = ctx.posts(GROUP).find(one => one.text === 'hello back')
        await ctx.idle(1)
        write({ text: 'and now?', reply_to_message: { message_id: answer.note, from: { id: 900 } } })
        await ctx.until(() => ctx.posts(GROUP).filter(one => one.text === 'hello back').length === 2)
        write({ text: '/status@sporebot' })
        await ctx.until(() => ctx.posts(GROUP).some(one => /^spore · /.test(one.text)))
        expect(readInbox(ctx.ws).map(entry => [entry.text, entry.overheard])).toEqual([['what failed?', false], ['and now?', false]])
        expect(ctx.posts(GROUP)).toHaveLength(3)
      })

      it('gives a spore that overhears what its people say there and not to it, starting no turn and owing no answer', async () => {
        let input = null
        ctx.replying(async (given) => { input = JSON.stringify(given); return answers('noted') })
        ctx.routes({ [GROUP]: { spore: 'triage', shared: true, people: ['41'], overhear: true } })
        ctx.start()
        write({ text: 'lunch at noon?' })
        write({ text: 'count me in' }, '42')
        write({ text: 'sticker' }, '41')
        await ctx.until(() => readInbox(ctx.ws).length === 2)
        await new Promise(resolve => setTimeout(resolve, 300))
        expect(readTurns(ctx.ws)).toEqual([])
        write(mentioning('what did we say?'))
        await ctx.until(() => ctx.posted(GROUP, 'noted'))
        expect(readInbox(ctx.ws).map(entry => [entry.text, entry.overheard, entry.fromId, entry.replyTo])).toEqual([
          ['lunch at noon?', true, 'telegram:41', null],
          ['sticker', true, 'telegram:41', null],
          ['what did we say?', false, 'telegram:41', `telegram:triage/${GROUP}`]
        ])
        expect(input).toContain('Overheard: said in the conversation, not to you')
        expect(input).toContain('lunch at noon?')
        expect(input).not.toContain('count me in')
        await ctx.until(() => outbox(ctx.ws)[0]?.state === 'delivered')
        expect(outbox(ctx.ws).map(entry => [entry.recipient, entry.answers])).toEqual([[`telegram:triage/${GROUP}`, [3]]])
        expect(ctx.posts(GROUP).map(one => one.text)).toEqual(['noted'])
      })

      it('says when it starts, for each group, that the bot\'s privacy mode keeps mentions and what it would overhear from it', async () => {
        ctx.routes({ [GROUP]: { spore: 'triage', shared: true, overhear: true }, '-6': { spore: 'triage', shared: true }, 1: { spore: 'triage' } })
        ctx.start({ adapter: createAdapter({ telegram: ctx.platform, bot: 'triage', me: { ...ME, can_read_all_group_messages: false } }) })
        await ctx.until(() => ctx.logs.filter(line => / turn its privacy mode off /.test(line)).length === 2)
        expect(ctx.logs.filter(line => /privacy mode/.test(line)).map(line => line.split(' — ')[0])).toEqual([
          'group -5: @sporebot gets only commands for it and replies to its messages there, no mention and nothing to overhear',
          'group -6: @sporebot gets only commands for it and replies to its messages there, no mention'
        ])
      })
    })

    it('refuses to share a bot with another process', async () => {
      ctx.platform.fail('updates', Object.assign(harness.refused('Conflict: terminated by other getUpdates request'), { context: { status: 409, retryAfter: null } }))
      const handle = ctx.start()
      await expect(handle.done).rejects.toMatchObject({ type: 'TELEGRAM_CONFLICT' })
    })
  })
})
