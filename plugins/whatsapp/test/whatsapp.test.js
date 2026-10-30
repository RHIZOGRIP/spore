import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { botPath, routesOf } from '@rhizogrip/spore/relay'

import { createGraph } from '../src/api.js'
import { WHATSAPP, choiceOf, createAdapter, listenOf, normalize } from '../src/adapter.js'
import { toWhatsApp } from '../src/format.js'
import { serve } from '../src/server.js'

const NUMBER = '106540352242922'
const ALICE = 'US.13491208655302741918'

let DIR
let path
const bot = (fields) => writeFileSync(path, JSON.stringify({ number: NUMBER, token: '${OPS_WHATSAPP_TOKEN}', secret: '${OPS_WHATSAPP_SECRET}', verify: '${OPS_WHATSAPP_VERIFY}', ...fields })) // eslint-disable-line no-template-curly-in-string

beforeEach(() => {
  DIR = mkdtempSync(resolve(tmpdir(), 'spore-whatsapp-test-'))
  path = botPath(WHATSAPP, 'ops', resolve(DIR, 'config.json'))
  mkdirSync(resolve(DIR, 'whatsapp'), { recursive: true })
})
afterEach(() => rmSync(DIR, { recursive: true, force: true }))

describe('a bot\'s people', () => {
  it('read each person\'s chat by their business-scoped user id, against the spore it reaches', () => {
    bot({ people: { [ALICE]: 'triage', 'GB.7': { spore: 'ledger', brief: true } } })
    expect(routesOf(WHATSAPP, path)).toEqual(new Map([
      [ALICE, { spores: ['triage'], details: false, show: null, brief: false, people: null, overhear: false }],
      ['GB.7', { spores: ['ledger'], details: false, show: null, brief: true, people: null, overhear: false }]
    ]))
  })

  it('refuse a phone number or a parent id where a business-scoped user id goes, and a show WhatsApp cannot give', () => {
    bot({ people: { 16505551234: 'triage' } })
    expect(() => routesOf(WHATSAPP, path)).toThrow(expect.objectContaining({ message: expect.stringMatching(/which is not a business-scoped user id/), detail: expect.stringMatching(/the log names it when they first write/) }))
    bot({ people: { 'US.ENT.11815799212886844830': 'triage' } })
    expect(() => routesOf(WHATSAPP, path)).toThrow(/which is not a business-scoped user id/)
    bot({ people: { [ALICE]: { spore: 'triage', show: 'working' } } })
    expect(() => routesOf(WHATSAPP, path)).toThrow(expect.objectContaining({ detail: 'a person takes spore, brief' }))
  })

  it('refuse a bot without its phone number id, or with an address it cannot listen on, or a credential in clear', () => {
    bot({ number: undefined, people: {} })
    expect(() => routesOf(WHATSAPP, path)).toThrow(expect.objectContaining({ message: expect.stringMatching(/has no number/), detail: expect.stringMatching(/^number is the phone number id/) }))
    bot({ number: '+1 650 555 1234', people: {} })
    expect(() => routesOf(WHATSAPP, path)).toThrow(/has no number/)
    bot({ listen: '3979', people: {} })
    expect(() => routesOf(WHATSAPP, path)).toThrow(/listens on/)
    expect(listenOf({}, path).text).toBe('127.0.0.1:3979')
    bot({ verify: 'in-clear', people: {} })
    expect(() => routesOf(WHATSAPP, path)).toThrow(/has no verify spore can read/)
  })
})

describe('a message', () => {
  const contacts = [{ profile: { name: 'Alice Martin' }, user_id: ALICE }]
  const message = (fields) => ({ from_user_id: ALICE, id: 'wamid.A1', timestamp: '1739321024', ...fields })

  it('is the person\'s chat, under Meta\'s id for it, named as their profile names them', () => {
    expect(normalize(message({ type: 'text', text: { body: ' hello ' } }), contacts)).toEqual({
      id: 'wamid.A1',
      conversation: ALICE,
      message: 'wamid.A1',
      person: { id: ALICE, name: 'Alice Martin', groups: [] },
      spore: null,
      where: 'a chat on WhatsApp',
      shared: false,
      text: 'hello',
      command: null,
      addresses: null,
      files: []
    })
    expect(normalize(message({ type: 'text', text: { body: '/extend wall 30m' } }), [{ profile: { name: 'Alice', username: 'alice.m' }, user_id: ALICE }]))
      .toMatchObject({ command: { verb: 'extend', args: 'wall 30m' }, person: { name: 'Alice (@alice.m)' } })
    expect(normalize(message({ type: 'text', text: { body: 'hi' } }), undefined).person.name).toBe(ALICE)
  })

  it('lists the file it carries by its media id, its caption the text, and a voice note as one', () => {
    expect(normalize(message({ type: 'document', document: { id: '881', filename: 'q3.pdf', mime_type: 'application/pdf', caption: 'see this' } }), contacts))
      .toMatchObject({ text: 'see this', files: [{ name: 'q3.pdf', mime: 'application/pdf', bytes: null, ref: '881' }] })
    expect(normalize(message({ type: 'image', image: { id: '882', mime_type: 'image/jpeg' } }), contacts))
      .toMatchObject({ text: null, files: [{ name: 'image-882.jpg', mime: 'image/jpeg', ref: '882' }] })
    expect(normalize(message({ type: 'audio', audio: { id: '883', mime_type: 'audio/ogg; codecs=opus', voice: true } }), contacts).files)
      .toEqual([{ name: 'voice-883.ogg', mime: 'audio/ogg', bytes: null, ref: '883' }])
  })

  it('of a kind the service does not read has neither text nor a file', () => {
    expect(normalize(message({ type: 'location', location: { latitude: 1, longitude: 2 } }), contacts)).toMatchObject({ text: null, files: [] })
  })

  it('is refused with the line that would let it in', () => {
    expect(WHATSAPP.refusal(normalize(message({ type: 'text', text: { body: 'hi' } }), contacts), 'ops.json'))
      .toBe(`refused Alice Martin (${ALICE}) — to allow them, add "${ALICE}": "<a spore>" to the people of ops.json`)
  })

  it('that answers a button or a list row is a press on the question it replies to', () => {
    const pressed = (interactive) => choiceOf(message({ type: 'interactive', context: { from: '15550783881', id: 'wamid.Q' }, interactive }), contacts)
    expect(pressed({ type: 'button_reply', button_reply: { id: 'ap:a1:apply', title: 'Apply' } }))
      .toEqual({ conversation: ALICE, note: 'wamid.Q', data: 'ap:a1:apply', inputs: null, person: { id: ALICE, name: 'Alice Martin', groups: [] }, where: 'a chat on WhatsApp' })
    expect(pressed({ type: 'list_reply', list_reply: { id: 'ap:a1:later', title: 'Later' } }).data).toBe('ap:a1:later')
    expect(pressed({ type: 'nfm_reply', nfm_reply: { response_json: '{}' } })).toBe(null)
  })
})

describe('Markdown', () => {
  it('becomes WhatsApp\'s own markup', () => {
    expect(toWhatsApp('# Totals\n\n**bold**, *italic*, ~~gone~~ and `x = 1`; [the report](https://example.com/r) and https://example.com')).toBe(
      '*Totals*\n\n*bold*, _italic_, ~gone~ and `x = 1`; the report (https://example.com/r) and https://example.com')
    expect(toWhatsApp('```js\nconst a = 1\n```\n\n> quoted\n\n- one\n- two')).toBe('```\nconst a = 1\n```\n\n> quoted\n\n• one\n• two')
    expect(toWhatsApp('| a | bb |\n|---|---|\n| 1 | 2 |')).toBe('```\na | bb\n--+---\n1 | 2\n```')
  })
})

describe('the Graph API', () => {
  const answering = (status, body = {}, headers = {}) => async () => new Response(JSON.stringify(body), { status, headers })
  const failing = (code, details = 'why') => answering(400, { error: { message: `(#${code}) title`, code, error_data: { details } } })
  const reaching = (fetch) => {
    vi.stubGlobal('fetch', fetch)
    return createGraph({ token: 'tok', number: NUMBER })
  }
  afterEach(() => vi.unstubAllGlobals())

  it('sends to a person by their business-scoped user id, quoting the message it answers, under the token', async () => {
    const asked = []
    const graph = reaching(async (url, init) => {
      asked.push({ url, method: init.method, authorization: init.headers.authorization, body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ messaging_product: 'whatsapp', contacts: [{ input: ALICE, user_id: ALICE }], messages: [{ id: 'wamid.N' }] }))
    })
    expect(await graph.send(ALICE, { type: 'text', text: { body: 'hi' } }, 'wamid.A1')).toBe('wamid.N')
    expect(asked).toEqual([{
      url: `https://graph.facebook.com/v26.0/${NUMBER}/messages`,
      method: 'POST',
      authorization: 'Bearer tok',
      body: { messaging_product: 'whatsapp', recipient_type: 'individual', recipient: ALICE, type: 'text', text: { body: 'hi' }, context: { message_id: 'wamid.A1' } }
    }])
  })

  it('says what to try again and how long to wait, what is refused, and what means the token is no good', async () => {
    const send = (fetch) => reaching(fetch).send(ALICE, { type: 'text', text: { body: 'hi' } })
    await expect(send(failing(131056))).rejects.toMatchObject({ type: 'WHATSAPP_FAILED', retryable: true, context: { code: 131056, retryAfter: 6 } })
    await expect(send(failing(130429))).rejects.toMatchObject({ retryable: true })
    await expect(send(failing(131047, 'Message failed to send because more than 24 hours have passed since the customer last replied to this number.')))
      .rejects.toMatchObject({ type: 'WHATSAPP_FAILED', retryable: false, detail: expect.stringMatching(/more than 24 hours/), context: { code: 131047 } })
    await expect(send(failing(190))).rejects.toMatchObject({ type: 'WHATSAPP_REFUSED', retryable: false })
    await expect(send(answering(503))).rejects.toMatchObject({ retryable: true, context: { status: 503 } })
    await expect(send(async () => { throw new Error('ECONNRESET') })).rejects.toMatchObject({ retryable: true, detail: 'ECONNRESET' })
  })

  it('fetches a person\'s file by asking for its URL, then reading it with the token', async () => {
    const asked = []
    const graph = reaching(async (url, init) => {
      asked.push({ url, authorization: init?.headers?.authorization })
      return url.startsWith('https://graph.facebook.com/')
        ? new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=881', mime_type: 'application/pdf' }))
        : new Response('%PDF')
    })
    expect((await graph.download('881', { most: 1024 })).toString()).toBe('%PDF')
    expect(asked).toEqual([
      { url: `https://graph.facebook.com/v26.0/881?phone_number_id=${NUMBER}`, authorization: 'Bearer tok' },
      { url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=881', authorization: 'Bearer tok' }
    ])
  })
})

describe('the adapter', () => {
  const graphed = () => {
    const sent = []
    return {
      sent,
      graph: {
        send: async (person, content, answering = null) => { sent.push({ person, content, answering }); return `wamid.${sent.length}` },
        typing: async (id) => { sent.push({ typing: id }) }
      }
    }
  }
  const choices = (n, label = (i) => `Option ${i}`) => Array.from({ length: n }, (_, i) => ({ id: `o${i}`, label: label(i), style: null, data: `ap:a1:o${i}` }))
  const fallback = { text: 'Apply the new **value**?', facts: [['Now', '82 %']] }

  it('asks with reply buttons up to three choices, a list up to ten, and refuses what fits neither', async () => {
    const { sent, graph } = graphed()
    const adapter = createAdapter({ graph, receive: () => {}, number: NUMBER })
    expect(await adapter.ask(ALICE, { native: null, fallback }, choices(3))).toEqual({
      note: 'wamid.1',
      shown: {
        type: 'button',
        body: { text: 'Apply the new *value*?\n\n*Now*: 82 %' },
        action: { buttons: [0, 1, 2].map(i => ({ type: 'reply', reply: { id: `ap:a1:o${i}`, title: `Option ${i}` } })) }
      }
    })
    expect((await adapter.ask(ALICE, { native: null, fallback }, choices(5))).shown.action).toEqual({ button: 'Choose', sections: [{ rows: [0, 1, 2, 3, 4].map(i => ({ id: `ap:a1:o${i}`, title: `Option ${i}` })) }] })
    expect((await adapter.ask(ALICE, { native: null, fallback }, choices(2, () => 'a label of twenty-two'))).shown.type).toBe('list')
    await expect(adapter.ask(ALICE, { native: null, fallback }, choices(2, () => 'a label longer than twenty-four'))).rejects.toMatchObject({ type: 'WHATSAPP_ASK_REFUSED', retryable: false })
    await expect(adapter.ask(ALICE, { native: null, fallback: { text: 'x'.repeat(1025) } }, choices(2))).rejects.toMatchObject({ type: 'WHATSAPP_ASK_REFUSED' })
    expect(sent).toHaveLength(3)
  })

  it('closes a question with a reply to it, since its buttons cannot be taken back', async () => {
    const { sent, graph } = graphed()
    const adapter = createAdapter({ graph, receive: () => {}, number: NUMBER })
    expect(await adapter.settle(ALICE, 'wamid.Q', { shown: {}, outcome: 'Apply — Alice Martin' })).toEqual({ text: '*Apply — Alice Martin*' })
    expect(await adapter.settle(ALICE, 'wamid.Q', { native: null, fallback: { text: 'Applied.' } })).toEqual({ text: 'Applied.' })
    await expect(adapter.settle(ALICE, 'wamid.Q', { native: { text: 'x' }, fallback: null })).rejects.toMatchObject({ type: 'WHATSAPP_ASK_REFUSED' })
    expect(sent.map(one => [one.content.text.body, one.answering])).toEqual([['*Apply — Alice Martin*', 'wamid.Q'], ['Applied.', 'wamid.Q']])
  })

  it('takes a delivery\'s messages and presses for its own number, logs a failed delivery of its own, and shows typing against the person\'s last message', async () => {
    const { sent, graph } = graphed()
    let deliver
    const adapter = createAdapter({ graph, receive: ({ onDelivery }) => { deliver = onDelivery }, number: NUMBER })
    let saved = 0
    adapter.restore({ latest: {} }, () => { saved += 1 })
    const messages = []
    const presses = []
    const logs = []
    adapter.listen({ onMessage: async (one) => { messages.push(one) }, onChoice: async (one) => { presses.push(one); await one.acknowledge('Apply — recorded') }, trace: () => {}, signal: new AbortController().signal, log: (line) => logs.push(line) })
    const value = (fields, number = NUMBER) => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550783881', phone_number_id: number }, ...fields } }] }] })
    const contacts = [{ profile: { name: 'Alice Martin' }, user_id: ALICE }]

    await deliver(value({ contacts, messages: [{ from_user_id: ALICE, id: 'wamid.A1', type: 'text', text: { body: 'hello' } }, { from_user_id: ALICE, id: 'wamid.A2', type: 'reaction', reaction: { message_id: 'wamid.9', emoji: '👍' } }] }))
    await deliver(value({ contacts, messages: [{ from_user_id: ALICE, id: 'wamid.P1', type: 'interactive', context: { id: 'wamid.Q' }, interactive: { type: 'button_reply', button_reply: { id: 'ap:a1:apply', title: 'Apply' } } }] }))
    await deliver(value({ messages: [{ from: '16505551234', id: 'wamid.X', type: 'text', text: { body: 'hi' } }] }))
    await deliver(value({ statuses: [{ id: 'wamid.N', status: 'failed', recipient_user_id: ALICE, errors: [{ code: 131047, title: 'Re-engagement message', error_data: { details: 'more than 24 hours' } }] }, { id: 'wamid.M', status: 'delivered', recipient_user_id: ALICE }] }))
    await deliver(value({ contacts, messages: [{ from_user_id: ALICE, id: 'wamid.B1', type: 'text', text: { body: 'elsewhere' } }] }, '999'))

    expect(messages.map(one => one.id)).toEqual(['wamid.A1'])
    expect(presses.map(one => [one.data, one.note])).toEqual([['ap:a1:apply', 'wamid.Q']])
    expect(logs).toEqual([
      'message wamid.X carries no business-scoped user id, not taken',
      `chat ${ALICE}: message wamid.N was not delivered (131047 Re-engagement message — more than 24 hours)`,
      `dropped a delivery for number 999: this bot is ${NUMBER}`
    ])
    expect(saved).toBe(2)
    await adapter.typing(ALICE)
    expect(sent).toEqual([{ person: ALICE, content: { type: 'text', text: { body: 'Apply — recorded' } }, answering: 'wamid.P1' }, { typing: 'wamid.P1' }])
  })
})

describe('the listener', () => {
  let stop
  let port
  const taken = []
  const logs = []
  const SECRET = 'app-secret'
  const listening = async (onDelivery = async (delivery) => { taken.push(delivery) }) => {
    const controller = new AbortController()
    stop = () => controller.abort()
    port = await new Promise(resolve => serve({ host: '127.0.0.1', port: 0, secret: SECRET, verify: 'v3rify', onDelivery, signal: controller.signal, log: (line) => logs.push(line), listening: resolve }))
  }
  const post = (body, { at = '/webhook', secret = SECRET } = {}) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body)
    return fetch(`http://127.0.0.1:${port}${at}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` }, body: raw })
  }
  beforeEach(() => { taken.length = 0; logs.length = 0 })
  afterEach(() => stop())

  it('answers Meta\'s check with its challenge when the verify token is the bot\'s, and refuses it otherwise', async () => {
    await listening()
    const check = (token) => fetch(`http://127.0.0.1:${port}/webhook?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1158201444`)
    const passed = await check('v3rify')
    expect([passed.status, await passed.text()]).toEqual([200, '1158201444'])
    expect((await check('guess')).status).toBe(403)
    expect(logs).toEqual(['Meta checked the callback URL', 'refused a check of the callback URL: its verify token is not this bot\'s'])
  })

  it('answers 200 once a delivery is taken, 401 to one not signed with the app secret, and takes nothing else', async () => {
    await listening()
    expect((await post({ entry: 1 })).status).toBe(200)
    expect((await post({ entry: 2 }, { secret: 'another' })).status).toBe(401)
    expect((await post({ entry: 3 }, { at: '/other' })).status).toBe(404)
    expect((await post('{nope')).status).toBe(400)
    expect((await post('x'.repeat(4 * 1024 * 1024 + 1))).status).toBe(413)
    expect(taken).toEqual([{ entry: 1 }])
    expect(logs).toEqual(['refused a delivery: it is not signed with this app\'s secret'])
  })

  it('answers 500 to a delivery the service could not take, so Meta delivers it again', async () => {
    await listening(async () => { throw new Error('busy database') })
    expect((await post({ entry: 1 })).status).toBe(500)
    expect(logs).toEqual(['a delivery not taken — busy database'])
  })
})
