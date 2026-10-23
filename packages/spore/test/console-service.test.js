/**
 * The console connector against real spores: the relay's conformance suite with the console's event
 * log behind a stand-in transport, and the console's HTTP face end to end.
 */

import './fixtures/own-config.js'
import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

import { conformance } from './fixtures/relay-conformance.js'
import { answers, calls } from './fixtures/scripted-model.js'
import { approvalOf, readInbox } from '../src/core/spore-dir.js'
import { requestApproval } from '../src/library/verbs.js'
import { send } from '../src/core/send.js'
import { SporeError } from '../src/index.js'
import { routesOf } from '../src/relay/index.js'
import { CONSOLE, createAdapter } from '../../../plugins/console/src/adapter.js'
import { openEvents } from '../../../plugins/console/src/events.js'
import { serve } from '../../../plugins/console/src/server.js'

const TOKEN = 'triage-token'
const OPS = ['post', 'edit', 'remove', 'upload', 'fetch']

const standIn = () => {
  const events = openEvents(':memory:')
  const waiting = []
  const faults = []
  let wake = null
  let said = 0
  return {
    events,
    http: null,
    uploads: new Map(),
    nextId: () => `m${++said}`,
    fault (op) {
      const found = faults.find(one => one.op === op && one.times > 0)
      if (!found) return
      found.times -= 1
      throw found.error
    },
    fail: (op, error, times = 1) => faults.push({ op, error, times }),
    push (job) {
      waiting.push(job)
      wake?.()
    },
    async receive (handlers) {
      if (this.http) return serve({ ...this.http, events, ...handlers })
      const { signal } = handlers
      while (!signal.aborted) {
        if (!waiting.length) {
          await new Promise(resolve => {
            wake = resolve
            signal.addEventListener('abort', resolve, { once: true })
          })
          wake = null
          continue
        }
        await waiting.shift()(handlers)
      }
    }
  }
}

const seenOf = (uploads) => (event) => {
  const note = String(event.seq)
  if (event.type === 'reply' || event.type === 'question') return [{ op: 'post', note, text: event.text, answering: event.answers.length ? String(event.answers.at(-1)) : null, formatted: false }]
  if (event.type === 'notice') return [{ op: 'post', note, text: event.text, answering: null, formatted: false }]
  if (event.type === 'working') {
    if (event.note === undefined) return [{ op: 'post', note, text: event.text, answering: null, formatted: false }]
    return [event.removed ? { op: 'remove', note: String(event.note) } : { op: 'edit', note: String(event.note), text: event.text }]
  }
  if (event.type === 'file') return [{ op: 'upload', path: uploads.get(event.seq), caption: event.name }]
  if (event.type === 'card') {
    return [{
      op: 'ask',
      note,
      text: JSON.stringify(event.body),
      choices: event.options.map(option => ({ label: option.label, data: `ap:${event.approval}:${option.id}`, style: option.style })),
      fields: event.fields.map(field => ({ id: field.id, label: field.label, value: field.value ?? null, required: field.required ?? false }))
    }]
  }
  if (event.type === 'closed') return [{ op: 'close', note: String(event.note), text: JSON.stringify(event) }]
  return []
}

const harness = {
  spec: CONSOLE,
  words: (text) => text,
  formats: false,
  credentials: { TRIAGE_CONSOLE_TOKEN: TOKEN, OTHER_CONSOLE_TOKEN: 'other-token' },
  botFile: (bot, table, fields = {}) => {
    const people = Object.entries(table).map(([who, { spore, details, brief }]) =>
      [who, details || brief !== undefined ? { spore, ...(details ? { details } : {}), ...(brief !== undefined ? { brief } : {}) } : spore])
    return { listen: '127.0.0.1:8790', token: `\${${bot.toUpperCase()}_CONSOLE_TOKEN}`, people: Object.fromEntries(people), ...fields }
  },
  platform: standIn,
  adapter (stand, bot) {
    const live = createAdapter({ name: bot, events: stand.events, receive: (handlers) => stand.receive(handlers) })
    const faulty = Object.fromEntries(OPS.map(op => [op, async (...args) => {
      stand.fault(op)
      return live[op](...args)
    }]))
    const upload = async (conversation, file, ...rest) => {
      await faulty.upload(conversation, file, ...rest)
      const written = stand.events.after(conversation, 0, 100_000).filter(event => event.type === 'file').at(-1)
      stand.uploads.set(written.seq, file.path)
    }
    return { ...live, ...faulty, upload }
  },
  say (stand, { conversation, text, files = [], id = stand.nextId() }) {
    const said = stand.events.say(conversation, id, { text, files: files.map(file => ({ name: file.name, mime: file.mime, bytes: file.data.length })) })
    if (!said.delivered) stand.push(({ deliver }) => deliver({ event: said.event, files }))
    return { id, message: String(said.event.seq), from: { name: conversation, id: `console:${conversation}`, where: 'the console "triage"' } }
  },
  seen: (stand, conversation) => stand.events.after(conversation, 0, 100_000).flatMap(seenOf(stand.uploads)),
  press (stand, { data, person, inputs = null }) {
    const [, approval, choice] = /^ap:([0-9a-f]{12}):(.+)$/.exec(data)
    let heard
    stand.push(async ({ press }) => { heard = await press({ card: stand.events.cardOf(approval), choice, by: person, inputs }) })
    return { acknowledged: () => heard === undefined ? undefined : { text: heard.text } }
  },
  fail: (stand, op, error, times) => stand.fail(op, error, times),
  retryable: (retryAfter) => new SporeError('the console could not write it', { type: 'CONSOLE_FAILED', retryable: true, detail: 'busy', context: { retryAfter } }),
  refused: (detail) => new SporeError('the console refused it', { type: 'CONSOLE_FAILED', retryable: false, detail, context: { retryAfter: null } }),
  command: (verb, args) => `/${verb}${args ? ` ${args}` : ''}`
}

conformance(harness, (ctx) => {
  describe('over HTTP', () => {
    const SECRET = 'hook-secret'
    let port

    const listening = () => {
      port = undefined
      ctx.platform.http = {
        host: '127.0.0.1',
        port: 0,
        token: TOKEN,
        file: join(ctx.root, 'console', 'triage.json'),
        people: () => routesOf(CONSOLE, join(ctx.root, 'console', 'triage.json')),
        listening: (at) => { port = at }
      }
      ctx.start({ approveEveryMs: 50 })
      return ctx.until(() => port)
    }

    const call = async (method, path, body, headers = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined
      })
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) : null }
    }

    it('says a message once however often it is sent, and answers the one waiting with what led to the reply and the reply', async () => {
      ctx.replying(async () => answers('checked it'))
      await listening()
      const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
      const sent = await call('POST', '/messages?wait=30', { person: '1', text: 'check it', id: 'c1' }, { traceparent })
      expect(sent.status).toBe(200)
      expect(sent.body).toMatchObject({ seq: expect.any(Number), repeated: false, answer: { type: 'reply', text: 'checked it', answers: [sent.body.seq], turn: { turnNo: 1, stopReason: 'answer' }, origin: null, spore: 'triage' } })
      expect(sent.body.events.at(-1)).toEqual(sent.body.answer)

      const again = await call('POST', '/messages', { person: '1', text: 'check it', id: 'c1' })
      expect(again.body).toEqual({ seq: sent.body.seq, repeated: true })
      expect(readInbox(ctx.ws)).toHaveLength(1)
      expect(readInbox(ctx.ws)[0]).toMatchObject({ requestId: 'console:triage:c1', replyTo: 'console:triage/1', fromWhere: 'the console "triage"', traceparent })

      await ctx.until(() => ctx.platform.events.after('1', sent.body.answer.seq, 100).some(event => event.removed))
      const read = await call('GET', `/conversations/1?after=${sent.body.seq}`)
      expect(read.body.events.slice(0, sent.body.events.length)).toEqual(sent.body.events)
      expect(read.body.next).toBe(read.body.events.at(-1).seq)
      expect((await call('GET', `/conversations/1?after=${read.body.next}&wait=1`)).body).toEqual({ events: [], next: read.body.next })
    })

    it('gives nothing without its token, nothing to a web page, and nothing of a person it does not map', async () => {
      await listening()
      expect((await call('POST', '/messages', { person: '1', text: 'hi', id: 'x' }, { authorization: 'Bearer wrong' }))).toEqual({ status: 401, body: null })
      expect((await call('GET', '/conversations/1', null, { origin: 'https://example.com' })).status).toBe(403)
      const stranger = await call('POST', '/messages', { person: '2', text: 'hi', id: 'x' })
      expect(stranger).toEqual({ status: 403, body: { error: expect.stringMatching(/^"2" is not among the people of .*triage\.json/) } })
      expect((await call('GET', '/conversations/2')).status).toBe(403)
      expect(readInbox(ctx.ws)).toEqual([])
    })

    it('shows an approval asked of a person as a card, takes a press only as the relay does, and closes it with how it ended', async () => {
      const heard = []
      const hook = createServer((request, response) => {
        const chunks = []
        request.on('data', chunk => chunks.push(chunk))
        request.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          const signed = request.headers['x-spore-signature'] === `sha256=${createHmac('sha256', SECRET).update(`${request.headers['x-spore-timestamp']}.${raw}`).digest('hex')}`
          heard.push({ ...JSON.parse(raw), signed })
          response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ tell: '82 % is in' }))
        })
      })
      await new Promise(resolve => hook.listen(0, '127.0.0.1', resolve))
      try {
        const secret = '${KPI_HOOK_SECRET}' // eslint-disable-line no-template-curly-in-string
        const configFile = join(ctx.root, 'config.json')
        writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), approvals: { kpi: { url: `http://127.0.0.1:${hook.address().port}/hook`, secret } } }))
        ctx.env.KPI_HOOK_SECRET = SECRET
        ctx.replying(async () => answers('noted'))
        await listening()
        const { approval } = requestApproval({
          ws: ctx.ws,
          configFile,
          request: { to: 'console:triage/1', by: ['1'], options: [{ id: 'apply', label: 'Apply', style: 'positive' }, { id: 'cancel', label: 'Cancel' }], body: { console: { kpi: 'churn', value: '82 %' } }, fields: [{ id: 'reason', label: 'Why?' }], hook: 'kpi' }
        })
        let card
        await ctx.until(() => (card = ctx.platform.events.cardOf(approval)))
        expect(card).toMatchObject({ type: 'card', person: '1', approval, spore: 'triage', body: { console: { kpi: 'churn', value: '82 %' } }, options: [{ id: 'apply', label: 'Apply', style: 'positive' }, { id: 'cancel', label: 'Cancel', style: null }], fields: [{ id: 'reason', label: 'Why?' }], by: ['1'], until: approvalOf(ctx.ws, approval).until })

        expect(await call('POST', `/approvals/${approval}/answer`, { choice: 'maybe', by: '1' })).toEqual({ status: 409, body: { taken: false, reason: 'that is not one of its choices' } })
        expect((await call('POST', `/approvals/${approval}/answer`, { choice: 'apply', by: '2' })).status).toBe(403)
        expect(await call('POST', `/approvals/${approval}/answer`, { choice: 'apply', by: '1', inputs: { reason: 'checked' } })).toEqual({ status: 200, body: { taken: true, text: 'Apply — recorded' } })
        expect(await call('POST', `/approvals/${approval}/answer`, { choice: 'cancel', by: '1' })).toEqual({ status: 409, body: { taken: false, reason: 'this was answered already' } })

        await ctx.until(() => ctx.posted('1', 'noted'))
        expect(heard).toEqual([expect.objectContaining({ approval, outcome: 'answered', choice: { id: 'apply', label: 'Apply' }, by: { id: '1', name: '1', platform: 'console' }, inputs: { reason: 'checked' }, signed: true })])
        const closed = ctx.platform.events.after('1', card.seq, 100).find(event => event.type === 'closed')
        expect(closed).toMatchObject({ approval, note: card.seq, state: 'answered', choice: 'apply', by: { id: '1', name: '1' }, outcome: 'confirmed', reason: null, closing: 'Apply — 1' })
        expect(readInbox(ctx.ws).find(entry => entry.approval === approval).text).toMatch(/^1 chose "Apply", and the host confirmed it\.\n\nThe host adds:\n82 % is in$/)
      } finally {
        await new Promise(resolve => hook.close(resolve))
      }
    })

    it('streams a conversation as server-sent events, resuming after the last one seen', async () => {
      await listening()
      await call('POST', '/messages?wait=30', { person: '1', text: 'hello', id: 's1' })
      const [first] = ctx.platform.events.after('1', 0, 1)
      const controller = new AbortController()
      const response = await fetch(`http://127.0.0.1:${port}/conversations/1`, { headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream', 'last-event-id': String(first.seq) }, signal: controller.signal })
      expect(response.headers.get('content-type')).toBe('text/event-stream')
      const reader = response.body.getReader()
      let text = ''
      while (!text.includes('event: reply')) text += new TextDecoder().decode((await reader.read()).value)
      controller.abort()
      expect(text).not.toContain(`id: ${first.seq}\n`)
      expect(text).toMatch(/id: \d+\nevent: reply\ndata: \{.*"text":"hello back"/)
    })

    it('shows a turn the clock started with what said it, and a quiet one as quiet', async () => {
      ctx.defaultReplyTo('1')
      const configFile = join(ctx.root, 'config.json')
      writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), replyTo: { triage: 'console:triage/1' } }))
      ctx.replying(async (input, round) => round === 0 ? answers('two new papers') : calls('quiet', { because: 'no change' }))
      await listening()
      await ctx.until(() => ctx.savedState().cursors[ctx.ws])
      send(ctx.ws, 'Check.', { schedule: { name: 'digest', due: '2026-09-28T07:00:00Z' }, env: ctx.env })
      await ctx.until(() => ctx.platform.events.after('1', 0, 100).some(event => event.type === 'reply'))
      send(ctx.ws, 'Check again.', { schedule: { name: 'digest', due: '2026-09-28T08:00:00Z' }, env: ctx.env })
      await ctx.until(() => ctx.platform.events.after('1', 0, 100).some(event => event.type === 'quiet'))
      const shown = (await call('GET', '/conversations/1')).body.events.filter(event => ['reply', 'quiet'].includes(event.type))
      expect(shown).toEqual([
        expect.objectContaining({ type: 'reply', text: 'schedule "digest"\n\ntwo new papers', answers: [], origin: 'schedule "digest"', turn: { turnNo: 1, stopReason: 'answer' } }),
        expect.objectContaining({ type: 'quiet', origin: 'schedule "digest"', turn: { turnNo: 2, stopReason: 'quiet' } })
      ])
    })
  })
})
