import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { botPath, routesOf } from '@rhizogrip/spore/relay'

import { CONSOLE, createAdapter, messageOf } from '../src/adapter.js'
import { openEvents } from '../src/events.js'
import { serve } from '../src/server.js'

const TOKEN = 'the-token'

let DIR
let path
const consoleFile = (fields) => writeFileSync(path, JSON.stringify({ listen: '127.0.0.1:8790', token: '${LAB_CONSOLE_TOKEN}', ...fields })) // eslint-disable-line no-template-curly-in-string

beforeEach(() => {
  DIR = mkdtempSync(resolve(tmpdir(), 'spore-console-test-'))
  path = botPath(CONSOLE, 'lab', resolve(DIR, 'config.json'))
  mkdirSync(resolve(DIR, 'console'), { recursive: true })
})
afterEach(() => rmSync(DIR, { recursive: true, force: true }))

describe('a console\'s people', () => {
  it('read each person against the spore they reach, and refuse what is not a person or a spore', () => {
    consoleFile({ people: { 'u-1': 'main-u1', 'ann@lab': { spore: 'main-ann', details: true } } })
    expect(routesOf(CONSOLE, path)).toEqual(new Map([
      ['u-1', { spores: ['main-u1'], details: false, show: null, brief: false, people: null, overhear: false }],
      ['ann@lab', { spores: ['main-ann'], details: true, show: null, brief: false, people: null, overhear: false }]
    ]))
    consoleFile({ people: { 'a b': 'main' } })
    expect(() => routesOf(CONSOLE, path)).toThrow(/names "a b" among its people/)
    consoleFile({ people: { u1: { spore: 'main', shared: true } } })
    expect(() => routesOf(CONSOLE, path)).toThrow(/gives person u1 shared/)
    consoleFile({ people: { u1: 3 } })
    expect(() => routesOf(CONSOLE, path)).toThrow(/maps person u1 to something that is not a spore/)
    consoleFile({})
    expect(() => routesOf(CONSOLE, path)).toThrow(/has no people/)
    consoleFile({ listen: '0.0.0.0:8790', people: {} })
    expect(() => routesOf(CONSOLE, path)).toThrow(/listens on "0.0.0.0:8790"/)
  })
})

describe('the event log', () => {
  let events
  beforeEach(() => { events = openEvents(resolve(DIR, 'state', 'events.sqlite')) })
  afterEach(() => events.close())

  it('says a client id once, and keeps whether it reached the spore', () => {
    const first = events.say('u1', 'c1', { text: 'hello', files: [] })
    expect(first).toMatchObject({ repeated: false, delivered: false, event: { seq: 1, person: 'u1', type: 'message', id: 'c1', text: 'hello' } })
    expect(events.say('u1', 'c1', { text: 'hello again', files: [] })).toMatchObject({ repeated: true, delivered: false, event: first.event })
    events.delivered('c1')
    expect(events.say('u1', 'c1', { text: 'hello', files: [] }).delivered).toBe(true)
  })

  it('numbers every event once across people, and reads a person\'s back from a seq', () => {
    events.say('u1', 'a', { text: 'one', files: [] })
    events.append('u2', 'notice', { text: 'other' })
    events.say('u1', 'b', { text: 'two', files: [] })
    expect(events.after('u1', 0, 10).map(event => event.seq)).toEqual([1, 3])
    expect(events.after('u1', 1, 10).map(event => event.text)).toEqual(['two'])
    expect(events.after('u1', 0, 1)).toHaveLength(1)
  })

  it('has an answer answer every message no earlier answer did, up to the one it names', () => {
    const one = events.say('u1', 'a', { text: 'one', files: [] }).event.seq
    const two = events.say('u1', 'b', { text: 'two', files: [] }).event.seq
    expect(events.answering('u1', two)).toEqual([one, two])
    events.append('u1', 'reply', { text: 'both', answers: [one, two] })
    events.append('u1', 'reply', { text: 'from the clock', answers: [] })
    const three = events.say('u1', 'c', { text: 'three', files: [] }).event.seq
    expect(events.answering('u1', three)).toEqual([three])
    expect(events.answering('u2', three)).toEqual([])
  })
})

describe('the adapter', () => {
  let events
  let adapter
  beforeEach(() => {
    events = openEvents(':memory:')
    adapter = createAdapter({ name: 'lab', events, receive: () => {} })
  })
  afterEach(() => events.close())

  it('writes an answer as its turn\'s reply or question, a working message as working, and anything else as a notice', async () => {
    const asked = events.say('u1', 'a', { text: 'hello', files: [] }).event.seq
    const note = await adapter.post('u1', 'working…', { as: 'main', for: [{ person: 'u1', said: 'hello' }] })
    await adapter.edit('u1', note, 'working… · 1 read')
    await adapter.post('u1', 'Which one?', { answering: String(asked), as: 'main', turn: { turnNo: 4, stopReason: 'question' }, origin: null })
    await adapter.remove('u1', note)
    await adapter.post('u1', 'nothing is running', { as: 'main' })
    expect(events.after('u1', asked, 10).map(({ seq, at, person, ...event }) => event)).toEqual([
      { type: 'working', spore: 'main', text: 'working…', for: [{ person: 'u1', said: 'hello' }] },
      { type: 'working', note: Number(note), text: 'working… · 1 read' },
      { type: 'question', spore: 'main', text: 'Which one?', answers: [asked], turn: { turnNo: 4, stopReason: 'question' }, origin: null },
      { type: 'working', note: Number(note), removed: true },
      { type: 'notice', spore: 'main', text: 'nothing is running' }
    ])
  })

  it('takes a person\'s message as the relay does, its id the client\'s under the console\'s name', () => {
    const { event } = events.say('u1', 'c9', { text: '/extend wall 30m', files: [], traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' })
    expect(messageOf('lab', event, [{ name: 'a.txt', mime: 'text/plain', data: Buffer.from('abc') }])).toEqual({
      id: 'lab:c9',
      conversation: 'u1',
      message: String(event.seq),
      person: { id: 'u1', name: 'u1', groups: [], zone: null },
      spore: null,
      where: 'the console "lab"',
      shared: false,
      text: '/extend wall 30m',
      command: { verb: 'extend', args: 'wall 30m' },
      addresses: null,
      files: [{ name: 'a.txt', mime: 'text/plain', bytes: 3, ref: Buffer.from('abc') }],
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
    })
  })
})

describe('the listener', () => {
  let events
  let port
  let controller
  let served
  let delivered
  let pressed

  const call = async (method, route, body, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }

  beforeEach(async () => {
    consoleFile({ people: { u1: 'main', u2: 'other' } })
    events = openEvents(':memory:')
    delivered = []
    pressed = []
    controller = new AbortController()
    let listening
    const ready = new Promise(resolve => { listening = resolve })
    served = serve({
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
      file: path,
      events,
      people: () => routesOf(CONSOLE, path),
      deliver: async ({ event, files }) => {
        delivered.push({ event, files })
        events.delivered(event.id)
      },
      press: async (one) => {
        pressed.push(one)
        return one.choice === 'apply' ? { text: 'Apply — recorded', taken: true } : { text: 'that is not one of its choices', taken: false }
      },
      signal: controller.signal,
      log: () => {},
      listening
    })
    port = await ready
  })

  afterEach(async () => {
    controller.abort()
    await served
    events.close()
  })

  it('answers nothing without the token, and refuses a request a web page makes', async () => {
    expect(await call('GET', '/conversations/u1', undefined, { authorization: 'Bearer nope' })).toEqual({ status: 401, body: null })
    expect(await call('GET', '/conversations/u1', undefined, { authorization: '' })).toEqual({ status: 401, body: null })
    expect(await call('GET', '/conversations/u1', undefined, { origin: 'https://evil.example' })).toEqual({ status: 403, body: { error: 'a request from a web page is refused' } })
    expect((await call('GET', '/elsewhere')).status).toBe(404)
  })

  it('says a message once, with the files it carries, and refuses one it cannot read', async () => {
    const files = [{ name: 'q3.txt', mime: 'text/plain', data: Buffer.from('numbers').toString('base64') }]
    const said = await call('POST', '/messages', { person: 'u1', text: 'see this', id: 'm1', files })
    expect(said).toEqual({ status: 200, body: { seq: 1, repeated: false } })
    expect(await call('POST', '/messages', { person: 'u1', text: 'see this', id: 'm1', files })).toEqual({ status: 200, body: { seq: 1, repeated: true } })
    expect(delivered).toHaveLength(1)
    expect(delivered[0].files).toEqual([{ name: 'q3.txt', mime: 'text/plain', data: Buffer.from('numbers') }])
    expect(delivered[0].event).toMatchObject({ text: 'see this', files: [{ name: 'q3.txt', mime: 'text/plain', bytes: 7 }] })

    expect((await call('POST', '/messages', { person: 'u2', text: 'mine now', id: 'm1' })).status).toBe(409)
    expect((await call('POST', '/messages', { person: 'u9', text: 'hi', id: 'm2' })).body.error).toMatch(/^"u9" is not among the people of /)
    for (const [body, problem] of [
      ['{', /not JSON/],
      [{ person: 'u1', id: 'm3' }, /text, files or both/],
      [{ person: 'u1', text: 'hi', id: 'a b' }, /id is the client's/],
      [{ person: 'u1', text: 'hi', id: 'm4', to: 'x' }, /not to/],
      [{ person: 'u1', text: 'hi', id: 'm5', files: [{ name: 'x' }] }, /files is/]
    ]) expect((await call('POST', '/messages', body)).body.error, JSON.stringify(body)).toMatch(problem)
    expect((await call('POST', '/messages', { person: 'u1', text: 'hi', id: 'm6' }, { traceparent: 'nope' })).body.error).toMatch(/traceparent/)
  })

  it('answers a message waited on with the events up to its reply, or what came before the wait ran out', async () => {
    setTimeout(() => {
      events.append('u1', 'working', { spore: 'main', text: 'working…', for: [] })
      events.append('u1', 'reply', { spore: 'main', text: 'hello back', answers: [1], turn: { turnNo: 3, stopReason: 'answer' }, origin: null })
    }, 50)
    const waited = await call('POST', '/messages?wait=5', { person: 'u1', text: 'hello', id: 'w1' })
    expect(waited.body).toMatchObject({ seq: 1, answer: { seq: 3, text: 'hello back' }, events: [{ seq: 2, type: 'working' }, { seq: 3, type: 'reply' }] })
    expect((await call('POST', '/messages?wait=1', { person: 'u1', text: 'again', id: 'w2' })).body).toEqual({ seq: 4, repeated: false, answer: null, events: [] })
  })

  it('reads a person\'s conversation after a seq, waiting for the next event when there is none', async () => {
    events.append('u1', 'notice', { text: 'one' })
    events.append('u2', 'notice', { text: 'theirs' })
    expect((await call('GET', '/conversations/u1')).body).toEqual({ events: [expect.objectContaining({ seq: 1, text: 'one' })], next: 1 })
    setTimeout(() => events.append('u1', 'notice', { text: 'two' }), 50)
    expect((await call('GET', '/conversations/u1?after=1&wait=5')).body).toEqual({ events: [expect.objectContaining({ seq: 3, text: 'two' })], next: 3 })
    expect((await call('GET', '/conversations/u1?after=3&wait=1')).body).toEqual({ events: [], next: 3 })
    expect((await call('GET', '/conversations/u1?limit=0')).status).toBe(400)
    expect((await call('GET', '/conversations/u9')).status).toBe(403)
  })

  it('presses a card only for people it maps, saying whether the press was taken', async () => {
    const card = events.append('u1', 'card', { approval: 'a1b2c3d4e5f6', spore: 'main', body: { default: { text: 'Apply?' } }, options: [], fields: [], by: ['u1'], until: 'x' })
    expect(await call('POST', '/approvals/a1b2c3d4e5f6/answer', { choice: 'apply', by: 'u1', inputs: { reason: 'ok' } })).toEqual({ status: 200, body: { taken: true, text: 'Apply — recorded' } })
    expect(pressed).toEqual([{ card, choice: 'apply', by: 'u1', inputs: { reason: 'ok' } }])
    expect(await call('POST', '/approvals/a1b2c3d4e5f6/answer', { choice: 'later', by: 'u1' })).toEqual({ status: 409, body: { taken: false, reason: 'that is not one of its choices' } })
    expect((await call('POST', '/approvals/a1b2c3d4e5f6/answer', { choice: 'apply', by: 'u9' })).status).toBe(403)
    expect((await call('POST', '/approvals/ffffffffffff/answer', { choice: 'apply', by: 'u1' })).status).toBe(404)
    consoleFile({ people: { u2: 'other' } })
    expect((await call('POST', '/approvals/a1b2c3d4e5f6/answer', { choice: 'apply', by: 'u2' })).status).toBe(403)
    expect(pressed).toHaveLength(2)
  })
})
