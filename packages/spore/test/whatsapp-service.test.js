/**
 * The WhatsApp connector against real spores: the relay's conformance suite with WhatsApp behind a
 * stand-in Graph API, and what is WhatsApp's alone.
 */

import './fixtures/own-config.js'
import { describe, it, expect } from 'vitest'
import { join } from 'node:path'

import { conformance } from './fixtures/relay-conformance.js'
import { answers } from './fixtures/scripted-model.js'
import { approvalOf, readInbox } from '../src/core/spore-dir.js'
import { requestApproval } from '../src/library/verbs.js'
import { SporeError } from '../src/index.js'
import { download } from '../src/relay/download.js'
import { WHATSAPP, createAdapter } from '../../../plugins/whatsapp/src/adapter.js'

const NUMBER = '106540352242922'
const OPS = { post: 'send', edit: 'edit', remove: 'remove', upload: 'document', fetch: 'download' }

const numberOf = (person) => person.slice(person.indexOf('.') + 1)
const nameOf = (person) => `U${numberOf(person)} Smith`

const standIn = () => {
  const waiting = []
  const sent = []
  const faults = []
  const delivered = new Map()
  const stored = new Map()
  const owners = new Map()
  const presses = new Set()
  let id = 100
  let wake = null
  const fault = (op) => {
    const found = faults.find(f => f.op === op && f.times > 0)
    if (!found) return
    found.times -= 1
    throw found.error
  }
  const next = () => `wamid.out${++id}`
  return {
    sent,
    delivered,
    stored,
    owners,
    presses,
    lastMessage: 0,
    push (delivery) { waiting.push(delivery); wake?.() },
    fail: (op, error, times = 1) => faults.push({ op, error, times }),
    graph: {
      send: async (person, content, answering = null) => {
        fault('send')
        const one = { op: 'send', person, id: next(), content, answering }
        sent.push(one)
        return one.id
      },
      react: async (person, message, emoji) => {
        fault('react')
        sent.push({ op: 'react', person, message, emoji: emoji === '' ? null : emoji })
      },
      typing: async (message) => {
        fault('typing')
        sent.push({ op: 'typing', person: owners.get(message), message })
      },
      document: async (person, { path, mime }, caption) => {
        fault('document')
        sent.push({ op: 'upload', person, path, mime, caption })
        return next()
      },
      download: async (media, { most }) => {
        fault('download')
        return download(`https://lookaside.example/${media}`, { most, fetchImpl: async () => new Response(stored.get(media)) })
      }
    },
    async receive ({ onDelivery, signal }) {
      while (!signal.aborted) {
        if (!waiting.length) {
          await new Promise(resolve => {
            wake = resolve
            signal.addEventListener('abort', resolve, { once: true })
          })
          wake = null
          continue
        }
        await onDelivery(waiting.shift())
      }
    }
  }
}

const deliveryOf = (person, message) => ({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'waba-1',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '15550783881', phone_number_id: NUMBER },
        contacts: [{ profile: { name: nameOf(person) }, user_id: person }],
        messages: [{ from_user_id: person, timestamp: '1798761600', ...message }]
      }
    }]
  }]
})

/**
 * What a person sees of what the bot sent: an interactive message is a question, a reply to one is
 * how it closed, and a reply to a press is the press's acknowledgement, which the suite reads
 * through `press`.
 */
const seenBy = (wa, person) => {
  const asked = new Set(wa.sent.filter(one => one.op === 'send' && one.content.type === 'interactive').map(one => one.id))
  return wa.sent.filter(one => one.person === person && !(one.op === 'send' && wa.presses.has(one.answering))).map(one => {
    if (one.op === 'react') return { op: 'react', message: one.message, emoji: one.emoji }
    if (one.op === 'typing') return { op: 'typing' }
    if (one.op === 'upload') return { op: 'upload', path: one.path, caption: one.caption }
    if (one.content.type === 'interactive') {
      const { interactive } = one.content
      const options = interactive.type === 'button' ? interactive.action.buttons.map(button => button.reply) : interactive.action.sections[0].rows
      return { op: 'ask', note: one.id, text: JSON.stringify(interactive), choices: options.map(option => ({ label: option.title, data: option.id, style: null })) }
    }
    if (asked.has(one.answering)) return { op: 'close', note: one.answering, text: one.content.text.body }
    return { op: 'post', note: one.id, text: one.content.text.body, answering: one.answering, formatted: false }
  })
}

const harness = {
  spec: WHATSAPP,
  conversation: (n) => `US.${n}`,
  words: (text) => text,
  formats: false,
  oneFilePerMessage: true,
  credentials: { TRIAGE_WHATSAPP_TOKEN: 'the-token', TRIAGE_WHATSAPP_SECRET: 'the-secret', TRIAGE_WHATSAPP_VERIFY: 'the-verify', OTHER_WHATSAPP_TOKEN: 'another-token', OTHER_WHATSAPP_SECRET: 'another-secret', OTHER_WHATSAPP_VERIFY: 'another-verify' },
  botFile: (bot, table, fields = {}) => {
    const variable = (field) => `\${${bot.toUpperCase()}_WHATSAPP_${field}}`
    const people = Object.entries(table).map(([person, { spore, brief }]) => [person, brief !== undefined ? { spore, brief } : spore])
    return { number: NUMBER, token: variable('TOKEN'), secret: variable('SECRET'), verify: variable('VERIFY'), listen: '127.0.0.1:3979', people: Object.fromEntries(people), ...fields }
  },
  platform: standIn,
  adapter: (wa) => createAdapter({ graph: wa.graph, receive: (options) => wa.receive(options), number: NUMBER }),
  say (wa, { conversation, text, files = [], id }) {
    const delivery = id === undefined
      ? (() => {
          expect(files.length).toBeLessThanOrEqual(1)
          const messageId = `wamid.in${++wa.lastMessage}`
          const [file] = files
          if (file) wa.stored.set(`media-${messageId}`, file.data)
          const message = file
            ? { id: messageId, type: 'document', document: { id: `media-${messageId}`, filename: file.name, mime_type: file.mime, ...(text === null ? {} : { caption: text }) } }
            : { id: messageId, type: 'text', text: { body: text ?? '' } }
          return deliveryOf(conversation, message)
        })()
      : wa.delivered.get(id)
    const [message] = delivery.entry[0].changes[0].value.messages
    wa.delivered.set(message.id, delivery)
    wa.owners.set(message.id, conversation)
    wa.push(delivery)
    return { id: message.id, message: message.id, from: { name: nameOf(conversation), id: `whatsapp:${conversation}`, where: 'a chat on WhatsApp' } }
  },
  seen: (wa, conversation) => seenBy(wa, conversation),
  press (wa, { note, data, person }) {
    const id = `wamid.in${++wa.lastMessage}`
    wa.presses.add(id)
    wa.owners.set(id, person)
    wa.push(deliveryOf(person, { id, type: 'interactive', context: { from: '15550783881', id: note }, interactive: { type: 'button_reply', button_reply: { id: data, title: data } } }))
    return {
      acknowledged: () => {
        const ack = wa.sent.find(one => one.op === 'send' && one.answering === id)
        return ack ? { text: ack.content.text.body } : undefined
      }
    }
  },
  fail: (wa, op, error, times) => wa.fail(OPS[op], error, times),
  retryable: (retryAfter) => new SporeError('whatsapp POST failed', { type: 'WHATSAPP_FAILED', retryable: true, detail: '(#130429) Rate limit hit', context: { status: 400, code: 130429, retryAfter } }),
  refused: (detail) => new SporeError('whatsapp POST failed', { type: 'WHATSAPP_FAILED', retryable: false, detail, context: { status: 400, code: 131026, retryAfter: null } }),
  command: (verb, args) => `/${verb}${args ? ` ${args}` : ''}`
}

conformance(harness, (ctx) => {
  describe('on WhatsApp', () => {
    const ONE = harness.conversation(1)
    const OPTIONS = ['Apply', 'Cancel', 'Later', 'Never'].map(label => ({ id: label.toLowerCase(), label }))

    it('asks an approval of more than three options as a list, and takes a press on one of its rows', async () => {
      ctx.start({ approveEveryMs: 50 })
      const id = requestApproval({
        ws: ctx.ws,
        configFile: join(ctx.root, 'config.json'),
        request: { to: `whatsapp:triage/${ONE}`, by: [ONE], options: OPTIONS, body: { default: { text: 'Apply the new **value**?' } } }
      }).approval
      await ctx.until(() => ctx.seen(ONE).some(one => one.op === 'ask'))
      const asked = ctx.platform.sent.find(one => one.op === 'send' && one.content.type === 'interactive')
      expect(asked.content.interactive).toMatchObject({ type: 'list', body: { text: 'Apply the new *value*?' }, action: { button: 'Choose' } })
      const question = ctx.seen(ONE).find(one => one.op === 'ask')
      expect(question.choices.map(one => one.label)).toEqual(['Apply', 'Cancel', 'Later', 'Never'])

      const pressed = harness.press(ctx.platform, { note: question.note, data: question.choices[2].data, person: ONE })
      await ctx.until(() => pressed.acknowledged())
      expect(pressed.acknowledged().text).toBe('Later — recorded')
      await ctx.until(() => approvalOf(ctx.ws, id).told)
      expect(approvalOf(ctx.ws, id)).toMatchObject({ state: 'answered', choice: 'later' })
      expect(ctx.seen(ONE).find(one => one.op === 'close')).toEqual({ op: 'close', note: question.note, text: '*Later — U1 Smith*' })
    })

    it('takes a file on its own with nothing written, and tells one over what the bot takes', async () => {
      ctx.routes({ [ONE]: { spore: 'triage' } }, {}, { files: '1KB' })
      ctx.start()
      ctx.say({ conversation: ONE, text: null, files: [{ name: 'small.txt', mime: 'text/plain', data: Buffer.from('fits') }] })
      await ctx.until(() => ctx.posted(ONE, 'hello back'))
      expect(readInbox(ctx.ws)[0].files).toMatchObject([{ name: 'small.txt', bytes: 4 }])

      ctx.say({ conversation: ONE, text: 'and this', files: [{ name: 'big.bin', mime: 'application/octet-stream', data: Buffer.from('x'.repeat(2048)) }] })
      await ctx.until(() => ctx.posted(ONE, 'big.bin did not reach the spore: over the 1KB this bot takes'))
      await ctx.until(() => readInbox(ctx.ws).length === 2)
      expect(readInbox(ctx.ws)[1].files[0]).toMatchObject({ name: 'big.bin', path: null, missing: expect.stringMatching(/over the 1KB this bot takes$/) })
    })

    it('shows typing against the message the person last sent', async () => {
      let release
      const opened = new Promise(resolve => { release = resolve })
      ctx.replying(async () => { await opened; return answers('hello back') })
      ctx.start()
      const asked = ctx.say({ conversation: ONE, text: 'hello' })
      await ctx.until(() => ctx.platform.sent.some(one => one.op === 'typing'))
      expect(ctx.platform.sent.find(one => one.op === 'typing')).toMatchObject({ person: ONE, message: asked.message })
      expect(ctx.savedState().latest).toEqual({ [ONE]: asked.message })
      release()
      await ctx.until(() => ctx.posted(ONE, 'hello back'))
    })
  })
})
