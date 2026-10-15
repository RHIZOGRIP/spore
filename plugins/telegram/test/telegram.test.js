import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { botPath, reactionsOf, routesOf } from '@rhizogrip/spore/relay'

import { createTelegram } from '../src/api.js'
import { TELEGRAM, normalize } from '../src/adapter.js'

let DIR
let path
const chats = (table) => writeFileSync(path, JSON.stringify({ token: '${TRIAGE_BOT_TOKEN}', chats: table })) // eslint-disable-line no-template-curly-in-string

beforeEach(() => {
  DIR = mkdtempSync(resolve(tmpdir(), 'spore-telegram-test-'))
  path = botPath(TELEGRAM, 'triage', resolve(DIR, 'config.json'))
  mkdirSync(resolve(DIR, 'telegram'), { recursive: true })
})
afterEach(() => rmSync(DIR, { recursive: true, force: true }))

describe('a bot\'s chats', () => {
  it('read each chat id against the spore it reaches, two chats on one spore among them', () => {
    chats({ 148392011: 'triage', '-1001234567': 'standup', 2: 'triage' })
    expect(routesOf(TELEGRAM, path)).toEqual(new Map([
      ['2', { spores: ['triage'], details: false, show: null }],
      ['148392011', { spores: ['triage'], details: false, show: null }],
      ['-1001234567', { spores: ['standup'], details: false, show: null }]
    ]))
  })

  it('take a chat that asks for details, or for how a turn shows itself', () => {
    chats({ 1: { spore: 'triage', details: true }, 2: { spore: 'triage', show: 'both' } })
    expect([...routesOf(TELEGRAM, path)].map(([chat, routed]) => [chat, routed.details, routed.show])).toEqual([['1', true, null], ['2', false, 'both']])
  })

  it('react only with what Telegram lets a bot react with', () => {
    writeFileSync(path, JSON.stringify({ token: '${TRIAGE_BOT_TOKEN}', chats: {}, react: { taken: '👀' } })) // eslint-disable-line no-template-curly-in-string
    expect(reactionsOf(TELEGRAM, path)).toEqual({ taken: '👀', failed: '💔' })
    writeFileSync(path, JSON.stringify({ token: '${TRIAGE_BOT_TOKEN}', chats: {}, react: { failed: '❌' } })) // eslint-disable-line no-template-curly-in-string
    expect(() => reactionsOf(TELEGRAM, path)).toThrow(/reacts with ❌, which Telegram does not take/)
  })

  it('refuse an entry that does not name a spore, or names a field it does not know, saying where one of the bot\'s goes', () => {
    chats({ 1: 42 })
    expect(() => routesOf(TELEGRAM, path)).toThrow(/not a spore/)
    chats({ 1: { spore: 'triage', detail: true } })
    expect(() => routesOf(TELEGRAM, path)).toThrow(expect.objectContaining({ message: expect.stringMatching(/gives chat 1 detail, which a chat does not take/), detail: 'a chat takes spore, details, show' }))
    chats({ 1: { spore: 'triage', show: 'react', react: { taken: '👀' } } })
    expect(() => routesOf(TELEGRAM, path)).toThrow(expect.objectContaining({ detail: 'a chat takes spore, details, show; react is the bot\'s, beside chats' }))
    writeFileSync(path, JSON.stringify({ token: '${TRIAGE_BOT_TOKEN}' })) // eslint-disable-line no-template-curly-in-string
    expect(() => routesOf(TELEGRAM, path)).toThrow(/has no chats/)
  })
})

describe('an update', () => {
  const update = (message, id = 7) => ({ update_id: id, message: { message_id: 40, chat: { id: 148392011, type: 'private' }, from: { id: 148392011, first_name: 'Alice', last_name: 'Martin', username: 'alice' }, ...message } })

  it('is a message from someone, in a chat, under an id the bot makes its own', () => {
    expect(normalize(update({ text: 'hello' }), 'triage')).toEqual({
      id: 'triage:7',
      conversation: '148392011',
      message: 40,
      person: { id: '148392011', name: 'Alice Martin (@alice)', username: 'alice' },
      where: 'a private chat on Telegram',
      shared: false,
      text: 'hello',
      command: null,
      addresses: null,
      files: 0
    })
  })

  it('says which group it came from, a conversation many people share', () => {
    expect(normalize(update({ text: 'hi', chat: { id: -100, type: 'supergroup', title: 'Payouts' } }), 'triage')).toMatchObject({ where: 'the Telegram group "Payouts"', shared: true })
  })

  it('reads a command, the bot\'s name after it or not', () => {
    expect(normalize(update({ text: '/status' }), 'triage').command).toEqual({ verb: 'status', args: '' })
    expect(normalize(update({ text: '/extend@sporebot wall 30m' }), 'triage').command).toEqual({ verb: 'extend', args: 'wall 30m' })
  })

  it('carries a caption as its text, counts what came with it, and has none when nothing was written', () => {
    expect(normalize(update({ caption: 'look', photo: [{}] }), 'triage')).toMatchObject({ text: 'look', files: 1 })
    expect(normalize(update({ sticker: {} }), 'triage')).toMatchObject({ text: null, files: 1 })
  })

  it('is nothing the relay takes when it is not a chat message', () => {
    expect(normalize({ update_id: 1, edited_message: {} }, 'triage')).toBe(null)
  })
})

describe('the bot API', () => {
  const answering = (result, { ok = true, status = 200, description, parameters } = {}) => async () =>
    new Response(JSON.stringify({ ok, result, description, parameters }), { status, headers: { 'content-type': 'application/json' } })
  const sending = (asked) => async (url, init) => {
    asked.push({ url, body: init.body instanceof FormData ? init.body : JSON.parse(init.body) })
    return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }))
  }

  it('refuses to start without a token', () => {
    expect(() => createTelegram(null)).toThrow(/no bot token/)
  })

  it('unwraps what Telegram sends back', async () => {
    const tg = createTelegram('t', { fetchImpl: answering({ username: 'sporebot' }) })
    expect(await tg.me()).toEqual({ username: 'sporebot' })
  })

  it('carries Telegram\'s own complaint, and does not retry a refusal', async () => {
    const tg = createTelegram('t', { fetchImpl: answering(null, { ok: false, status: 400, description: 'chat not found' }) })
    await expect(tg.say(1, 'x')).rejects.toMatchObject({ type: 'TELEGRAM_FAILED', detail: 'chat not found', retryable: false, context: { status: 400 } })
  })

  it('says how long Telegram asked it to wait', async () => {
    const tg = createTelegram('t', { fetchImpl: answering(null, { ok: false, status: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } }) })
    await expect(tg.revise(1, 2, 'x')).rejects.toMatchObject({ retryable: true, context: { status: 429, retryAfter: 7 } })
  })

  it('retries what never reached Telegram', async () => {
    const tg = createTelegram('t', { fetchImpl: async () => { throw new TypeError('fetch failed') } })
    await expect(tg.say(1, 'x')).rejects.toMatchObject({ retryable: true, detail: 'fetch failed' })
  })

  it('long polls with an offset, which is what confirms what came before it', async () => {
    const asked = []
    const tg = createTelegram('t', { fetchImpl: sending(asked) })
    await tg.updates(17)
    expect(asked[0].body).toMatchObject({ offset: 17, timeout: 30, allowed_updates: ['message'] })
  })

  it('answers a message as a reply to it, still sent when that message is gone, and removes one of its own', async () => {
    const asked = []
    const tg = createTelegram('t', { fetchImpl: sending(asked) })
    await tg.say(5, '<b>the answer</b>', { answering: 40, html: true })
    await tg.say(5, 'unprompted')
    await tg.remove(5, 41)
    expect(asked[0].body).toMatchObject({ chat_id: 5, text: '<b>the answer</b>', parse_mode: 'HTML', reply_parameters: { message_id: 40, allow_sending_without_reply: true } })
    expect(asked[1].body).not.toHaveProperty('reply_parameters')
    expect(asked[1].body).not.toHaveProperty('parse_mode')
    expect(asked[2]).toMatchObject({ url: expect.stringMatching(/deleteMessage$/), body: { chat_id: 5, message_id: 41 } })
  })

  it('reacts to a message with one emoji, takes it off with none, and says it is typing', async () => {
    const asked = []
    const tg = createTelegram('t', { fetchImpl: sending(asked) })
    await tg.react(5, 40, '🫡')
    await tg.react(5, 40, null)
    await tg.typing(5)
    expect(asked.map(({ url, body }) => [url.split('/').at(-1), body])).toEqual([
      ['setMessageReaction', { chat_id: 5, message_id: 40, reaction: [{ type: 'emoji', emoji: '🫡' }] }],
      ['setMessageReaction', { chat_id: 5, message_id: 40, reaction: [] }],
      ['sendChatAction', { chat_id: 5, action: 'typing' }]
    ])
  })

  it('uploads a document under its own name', async () => {
    const file = resolve(DIR, 'report.md')
    writeFileSync(file, '# report\n')
    const asked = []
    const tg = createTelegram('t', { fetchImpl: sending(asked) })
    await tg.document(5, { path: file, mime: 'text/markdown' }, 'data/out/report.md')
    expect(asked[0].url).toMatch(/sendDocument$/)
    expect(asked[0].body.get('chat_id')).toBe('5')
    expect(asked[0].body.get('caption')).toBe('data/out/report.md')
    expect(asked[0].body.get('document').name).toBe('report.md')
    expect(await asked[0].body.get('document').text()).toBe('# report\n')
  })
})
