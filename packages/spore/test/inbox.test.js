import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { appendInbox, appendTurn, outbox, readInbox, readInboxFrom, setAside, settleOutbox } from '../src/core/spore-dir.js'
import { send } from '../src/core/send.js'

const WS = resolve(tmpdir(), 'spore-inbox-test')

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
})
afterEach(() => rmSync(WS, { recursive: true, force: true }))

describe('the inbox', () => {
  it('takes a message sent with start: false and starts nothing, once under its request id', () => {
    expect(send(WS, 'for the next turn', { start: false, requestId: 'r-1' })).toEqual({ ws: WS, started: false, pid: null, inbox: 1, repeated: false })
    expect(send(WS, 'for the next turn', { start: false, requestId: 'r-1' })).toMatchObject({ started: false, inbox: 1, repeated: true })
    expect(readInbox(WS).map(said => said.text)).toEqual(['for the next turn'])
    expect(existsSync(resolve(WS, 'spore.out'))).toBe(false)
  })

  it('is empty and readable before anyone has said anything', () => {
    expect(readInboxFrom(WS)).toEqual({ messages: [], at: 0, person: null })
  })

  it('keeps where a webhook message came from, and refuses an origin without its delivery', () => {
    appendInbox(WS, '', { attach: [{ name: 'headers.json', mime: 'application/json', data: Buffer.from('{}') }], hook: { name: 'forge', event: 'push', delivery: 'd-9' } })
    const [entry] = readInbox(WS)
    expect(entry).toMatchObject({ hook: 'forge', hookEvent: 'push', hookDelivery: 'd-9' })
    expect(readInboxFrom(WS).messages[0]).toMatch(/^\[Sent by webhook "forge": event push, delivery d-9\./)
    expect(() => appendInbox(WS, 'x', { hook: { name: 'forge' } })).toThrow(/names its hook and its delivery/)
  })

  it('keeps who said a message and where, and the turn reads it above what they said', () => {
    const from = { name: 'Alice "A" Martin', id: 'telegram:148392011', where: 'a private chat on Telegram' }
    send(WS, 'can you check the payouts?', { start: false, from })
    expect(readInbox(WS)[0]).toMatchObject({ fromName: 'Alice "A" Martin', fromId: 'telegram:148392011', fromWhere: 'a private chat on Telegram' })
    expect(readInboxFrom(WS)).toMatchObject({
      messages: ['[Said by "Alice \\"A\\" Martin" (telegram:148392011) in "a private chat on Telegram".]\n\ncan you check the payouts?'],
      person: { fromName: 'Alice "A" Martin' }
    })
  })

  it('refuses a from that is not who and where, or that a schedule, webhook or job would also claim', () => {
    for (const from of [{ name: 'Alice' }, { name: 'Alice', id: '148392011', where: 'a chat' }, { name: ' ', id: 'telegram:1', where: 'a chat' }, { name: 'A', id: 'telegram:1', where: 'a chat', role: 'admin' }]) {
      expect(() => appendInbox(WS, 'x', { from })).toThrow(expect.objectContaining({ type: 'FROM_INVALID' }))
    }
    expect(() => appendInbox(WS, 'x', { from: { name: 'A', id: 'telegram:1', where: 'a chat' }, hook: { name: 'forge', delivery: 'd-1' } })).toThrow(expect.objectContaining({ type: 'FROM_INVALID' }))
    expect(readInbox(WS)).toEqual([])
  })

  it('reads from an inboxNo, so a turn sees only what it has not answered', () => {
    appendInbox(WS, 'first')
    const one = readInboxFrom(WS)
    expect(one.messages).toEqual(['first'])

    appendInbox(WS, 'second')
    const two = readInboxFrom(WS, one.at)
    expect(two.messages).toEqual(['second'])
    expect(readInboxFrom(WS, two.at).messages).toEqual([])
  })

  it('carries what was said, in the order it was said', () => {
    for (const said of ['a', 'b', 'c']) appendInbox(WS, said)
    expect(readInboxFrom(WS).messages).toEqual(['a', 'b', 'c'])
  })

  it('takes a message once per request id, however often it is sent, and writes nothing for a repeat', () => {
    const first = appendInbox(WS, 'yes', { requestId: 'u-1' })
    expect(appendInbox(WS, 'yes', { requestId: 'u-1', attach: [{ name: 'a.txt', data: Buffer.from('x') }] })).toBe(first)
    expect(appendInbox(WS, 'yes')).toBe(first + 1)
    expect(readInbox(WS).map(e => [e.text, e.files])).toEqual([['yes', null], ['yes', null]])
    expect(existsSync(resolve(WS, 'inbox.d'))).toBe(false)
    expect(() => appendInbox(WS, 'yes', { requestId: 7 })).toThrow(expect.objectContaining({ type: 'REQUEST_ID_INVALID' }))
  })

  it('refuses a message that says nothing, rather than leaving a turn nothing to answer', () => {
    expect(() => appendInbox(WS, '')).toThrow(expect.objectContaining({ type: 'MESSAGE_EMPTY' }))
    expect(readInbox(WS)).toEqual([])
  })
})

describe('where an entry lands', () => {
  it('is the inboxNo a turn reading it records, answered to the sender', () => {
    const first = appendInbox(WS, 'first')
    const second = appendInbox(WS, 'second')
    expect([first, second]).toEqual([1, 2])
    expect(readInbox(WS).map(entry => entry.inboxNo)).toEqual([first, second])
  })

  it('sets aside what one place said up to a message, which no turn then reads', () => {
    send(WS, 'first', { start: false, replyTo: 'telegram:main/42' })
    send(WS, 'from elsewhere', { start: false, replyTo: 'telegram:main/7' })
    send(WS, 'second', { start: false, replyTo: 'telegram:main/42' })
    send(WS, 'after the stop', { start: false, replyTo: 'telegram:main/42' })
    expect(setAside(WS, { replyTo: 'telegram:main/42', upto: 3 })).toEqual([1, 3])
    expect(readInbox(WS).map(entry => [entry.text, entry.setAside])).toEqual([
      ['first', true], ['from elsewhere', false], ['second', true], ['after the stop', false]
    ])
    const read = readInboxFrom(WS)
    expect(read.messages.map(message => message.split('\n').at(-1))).toEqual(['from elsewhere', 'after the stop'])
    expect(read.at).toBe(4)
  })

  it('reads a range of them, after one and up to another', () => {
    for (const said of ['a', 'b', 'c', 'd']) appendInbox(WS, said)
    expect(readInbox(WS, { after: 1, upto: 3 }).map(entry => entry.text)).toEqual(['b', 'c'])
  })
})

describe('a message sent with trace context', () => {
  const TRACED = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

  it('keeps it on the entry, out of what the agent reads', () => {
    appendInbox(WS, 'summarise the tickets', { traceparent: TRACED })
    expect(readInbox(WS)[0].traceparent).toBe(TRACED)
    expect(readInboxFrom(WS).messages).toEqual(['summarise the tickets'])
  })

  it('keeps where an answer goes, and refuses a reply-to that names no place', () => {
    appendInbox(WS, 'from the chat', { replyTo: 'telegram:main/42' })
    expect(readInbox(WS)[0].replyTo).toBe('telegram:main/42')
    expect(() => appendInbox(WS, 'x', { replyTo: 'nowhere' })).toThrow(expect.objectContaining({ type: 'INBOX_UNWRITABLE', detail: expect.stringMatching(/reply-to/) }))
    expect(readInbox(WS)).toHaveLength(1)
  })

  it('addresses a finished turn to where its messages asked from, for a plugin to settle once', () => {
    appendInbox(WS, 'one', { replyTo: 'telegram:main/42' })
    appendInbox(WS, 'two', { replyTo: 'terminal' })
    appendTurn(WS, { startedAt: 't', stopReason: 'answer', concluded: true, inboxTo: 2 })
    expect(outbox(WS).map(entry => [entry.recipient, entry.answers, entry.state])).toEqual([
      ['telegram:main/42', [1], 'pending'],
      ['terminal', [2], 'delivered']
    ])
    const [pending] = outbox(WS, { kind: 'telegram', state: 'pending' })
    expect(settleOutbox(WS, pending.outboxNo, { refused: 'the bot was removed from the chat' })).toBe(true)
    expect(settleOutbox(WS, pending.outboxNo)).toBe(false)
    expect(outbox(WS, { kind: 'telegram' })[0]).toMatchObject({ state: 'refused', reason: 'the bot was removed from the chat' })
  })

  it('refuses one that is not a W3C traceparent, and says nothing', () => {
    expect(() => appendInbox(WS, 'x', { traceparent: 'abc' })).toThrow(/not a W3C trace context/)
    expect(readInbox(WS)).toEqual([])
  })
})
