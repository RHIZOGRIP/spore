import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { botPath, reactionsOf, routesOf } from '@rhizogrip/spore/relay'

import { createTelegram } from '../src/api.js'
import { TELEGRAM, merged, normalize } from '../src/adapter.js'

let DIR
let path
const bot = (fields) => writeFileSync(path, JSON.stringify({ token: '${TRIAGE_BOT_TOKEN}', ...fields })) // eslint-disable-line no-template-curly-in-string
const ME = { id: 900, username: 'SporeBot' }

beforeEach(() => {
  DIR = mkdtempSync(resolve(tmpdir(), 'spore-telegram-test-'))
  path = botPath(TELEGRAM, 'triage', resolve(DIR, 'config.json'))
  mkdirSync(resolve(DIR, 'telegram'), { recursive: true })
})
afterEach(() => rmSync(DIR, { recursive: true, force: true }))

describe('a bot\'s people and groups', () => {
  it('read each person\'s private chat against the spore it reaches, and each group with its spore and who may address it', () => {
    bot({
      people: { 148392011: 'triage', 2: { spore: 'triage', details: true, show: 'both' }, 3: { spore: 'triage', brief: true } },
      groups: { '-1001234567': { spores: ['standup'], people: ['148392011', '*'], overhear: true, show: 'working' } }
    })
    expect(routesOf(TELEGRAM, path)).toEqual(new Map([
      ['2', { spores: ['triage'], details: true, show: 'both', brief: false, people: null, overhear: false }],
      ['3', { spores: ['triage'], details: false, show: null, brief: true, people: null, overhear: false }],
      ['148392011', { spores: ['triage'], details: false, show: null, brief: false, people: null, overhear: false }],
      ['-1001234567', { spores: ['standup'], details: false, show: 'working', brief: false, people: ['148392011', '*'], overhear: true }]
    ]))
    bot({ people: { 148392011: { spore: 'triage', brief: 'yes' } } })
    expect(() => routesOf(TELEGRAM, path)).toThrow(/person 148392011 whose brief is not true or false/)
  })

  it('take either alone, and people {} while the owner learns their id', () => {
    bot({ people: {} })
    expect(routesOf(TELEGRAM, path)).toEqual(new Map())
    bot({ groups: { '-5': { spores: ['triage'], people: ['*'] } } })
    expect([...routesOf(TELEGRAM, path).keys()]).toEqual(['-5'])
  })

  it('react only with what Telegram lets a bot react with', () => {
    bot({ people: {}, react: { taken: '👀' } })
    expect(reactionsOf(TELEGRAM, path)).toEqual({ taken: '👀', failed: '💔' })
    bot({ people: {}, react: { failed: '❌' } })
    expect(() => reactionsOf(TELEGRAM, path)).toThrow(/reacts with ❌, which Telegram does not take/)
  })

  it('refuse the chats a bot file had before, showing the shape it has now', () => {
    bot({ chats: { 148392011: 'triage' } })
    expect(() => routesOf(TELEGRAM, path)).toThrow(expect.objectContaining({ message: expect.stringMatching(/has a field spore does not know — chats$/), detail: expect.stringContaining('"people": { "<your user id>": "<spore>" }, "groups": ') }))
    bot({})
    expect(() => routesOf(TELEGRAM, path)).toThrow(/has no people and no groups/)
  })

  it('refuse a person who is not a person, or a group that is not a group', () => {
    bot({ people: { '-1001234567': 'triage' } })
    expect(() => routesOf(TELEGRAM, path)).toThrow(expect.objectContaining({ message: expect.stringMatching(/names "-1001234567" among its people, which is not a person's id/), detail: expect.stringMatching(/goes under groups/) }))
    bot({ groups: { 148392011: { spores: ['triage'], people: ['*'] } } })
    expect(() => routesOf(TELEGRAM, path)).toThrow(/names "148392011" among its groups, which is not a group's id/)
  })

  it('refuse a person without a spore, or a field it does not know, saying where one of the bot\'s goes', () => {
    bot({ people: { 1: 42 } })
    expect(() => routesOf(TELEGRAM, path)).toThrow(/maps person 1 to something that is not a spore/)
    bot({ people: { 1: { spore: 'triage', detail: true } } })
    expect(() => routesOf(TELEGRAM, path)).toThrow(expect.objectContaining({ message: expect.stringMatching(/gives person 1 detail, which a person does not take/), detail: 'a person takes spore, details, show, brief' }))
    bot({ people: { 1: { spore: 'triage', show: 'react', react: { taken: '👀' } } } })
    expect(() => routesOf(TELEGRAM, path)).toThrow(expect.objectContaining({ detail: 'a person takes spore, details, show, brief; react is the bot\'s, beside people and groups' }))
  })

  it('refuse a group with no spore or more than one, without its people written out, or with a flag that is not one', () => {
    const group = (entry) => bot({ groups: { '-5': entry } })
    group({ spores: [], people: ['*'] })
    expect(() => routesOf(TELEGRAM, path)).toThrow(/has a group -5 with no spores/)
    group({ spores: ['triage', 'ledger'], people: ['*'] })
    expect(() => routesOf(TELEGRAM, path)).toThrow(expect.objectContaining({ message: expect.stringMatching(/gives group -5 2 spores/), detail: expect.stringMatching(/a second spore there is a second bot/) }))
    group({ spores: ['triage'] })
    expect(() => routesOf(TELEGRAM, path)).toThrow(/has a group -5 whose people are not user ids or \*/)
    group({ spores: ['triage'], people: ['role:1'] })
    expect(() => routesOf(TELEGRAM, path)).toThrow(/whose people are not user ids or \*/)
    group({ spores: ['triage'], people: ['*'], overhear: 'yes' })
    expect(() => routesOf(TELEGRAM, path)).toThrow(/has a group -5 whose overhear is not true or false/)
  })
})

describe('an update', () => {
  const update = (message, id = 7) => ({ update_id: id, message: { message_id: 40, chat: { id: 148392011, type: 'private' }, from: { id: 148392011, first_name: 'Alice', last_name: 'Martin', username: 'alice' }, ...message } })
  const inGroup = (message) => update({ chat: { id: -100, type: 'supergroup', title: 'Payouts' }, ...message })

  it('is a message from someone, in a chat, under an id the bot makes its own', () => {
    expect(normalize(update({ text: 'hello' }), 'triage', ME)).toEqual({
      id: 'triage:7',
      conversation: '148392011',
      message: 40,
      person: { id: '148392011', name: 'Alice Martin (@alice)', username: 'alice', groups: [] },
      spore: null,
      where: 'a private chat on Telegram',
      shared: false,
      text: 'hello',
      command: null,
      addresses: null,
      files: []
    })
  })

  it('says which group it came from, a conversation many people share', () => {
    expect(normalize(inGroup({ text: 'hi' }), 'triage', ME)).toMatchObject({ where: 'the Telegram group "Payouts"', shared: true })
  })

  it('reads a command, the bot\'s name after it or not, and takes none naming another bot', () => {
    expect(normalize(update({ text: '/status' }), 'triage', ME).command).toEqual({ verb: 'status', args: '' })
    expect(normalize(update({ text: '/extend@sporebot wall 30m' }), 'triage', ME).command).toEqual({ verb: 'extend', args: 'wall 30m' })
    expect(normalize(inGroup({ text: '/status@otherbot' }), 'triage', ME)).toBe(null)
  })

  it('reaches the spore in a group when it mentions the bot, replies to it, or is a command for it — and names no spore otherwise', () => {
    const addressed = (message) => normalize(inGroup(message), 'triage', ME)
    expect(addressed({ text: '@sporebot what failed?', entities: [{ type: 'mention', offset: 0, length: 9 }] })).toMatchObject({ addresses: null, text: 'what failed?' })
    expect(addressed({ text: 'hey @SporeBot, look', entities: [{ type: 'mention', offset: 4, length: 9 }] })).toMatchObject({ addresses: null, text: 'hey look' })
    expect(addressed({ text: 'yes, that one', reply_to_message: { message_id: 39, from: { id: 900 } } })).toMatchObject({ addresses: null, text: 'yes, that one' })
    expect(addressed({ text: '/stop' })).toMatchObject({ addresses: null, command: { verb: 'stop', args: '' } })
    expect(addressed({ text: '/roll@sporebot 2' })).toMatchObject({ addresses: null, command: { verb: 'roll', args: '2' } })
    expect(addressed({ text: 'lunch at noon?' })).toMatchObject({ addresses: [], text: 'lunch at noon?' })
    expect(addressed({ text: 'ask @otherbot', entities: [{ type: 'mention', offset: 4, length: 9 }] })).toMatchObject({ addresses: [] })
    expect(addressed({ text: '/roll' })).toMatchObject({ addresses: [] })
    expect(addressed({ text: 'not to you', reply_to_message: { message_id: 39, from: { id: 41 } } })).toMatchObject({ addresses: [] })
    expect(addressed({ new_chat_members: [{ id: 900 }] })).toMatchObject({ addresses: [], text: null })
  })

  it('carries a caption as its text, lists what came with it, and has none when nothing was written', () => {
    const photo = [{ file_id: 'small', file_unique_id: 'u1', file_size: 900 }, { file_id: 'large', file_unique_id: 'u2', file_size: 90_000 }]
    expect(normalize(update({ caption: 'look', photo }), 'triage', ME)).toMatchObject({
      text: 'look',
      files: [{ name: 'photo-u2.jpg', mime: 'image/jpeg', bytes: 90_000, ref: 'large' }]
    })
    expect(normalize(update({ sticker: { file_id: 's', file_unique_id: 'u3' } }), 'triage', ME)).toMatchObject({
      text: null,
      files: [{ name: 'sticker-u3.webp', mime: 'image/webp', bytes: null, ref: 's' }]
    })
    expect(normalize(update({ document: { file_id: 'd', file_unique_id: 'u4', file_name: 'q3.pdf', mime_type: 'application/pdf', file_size: 30 * 1024 * 1024 } }), 'triage', ME).files)
      .toEqual([{ name: 'q3.pdf', mime: 'application/pdf', bytes: 30 * 1024 * 1024, ref: null, why: 'Telegram lets a bot fetch files up to 20 MB' }])
    expect(normalize(update({ voice: { file_id: 'v', file_unique_id: 'u5', mime_type: 'audio/ogg' } }), 'triage', ME).files)
      .toEqual([{ name: 'voice-u5.ogg', mime: 'audio/ogg', bytes: null, ref: 'v' }])
  })

  it('makes an album one message: what its captioned part said, and every part\'s files', () => {
    const part = (id, fields) => normalize({ update_id: id, message: { message_id: id, chat: { id: 148392011, type: 'private' }, from: { id: 148392011, first_name: 'Alice' }, media_group_id: 'a', ...fields } }, 'triage', ME)
    const parts = [
      part(7, { photo: [{ file_id: 'p1', file_unique_id: 'u1' }] }),
      part(8, { caption: 'both', photo: [{ file_id: 'p2', file_unique_id: 'u2' }] })
    ]
    expect(merged(parts)).toMatchObject({ id: 'triage:8', message: 8, text: 'both', files: [{ ref: 'p1' }, { ref: 'p2' }] })
  })

  it('is nothing the relay takes when it is not a chat message', () => {
    expect(normalize({ update_id: 1, edited_message: {} }, 'triage', ME)).toBe(null)
  })

  it('is refused with the line that would let it in — a person under people, a group under groups', () => {
    const message = (chat, from = {}) => normalize(update({ text: 'hi', chat, ...from }), 'triage', ME)
    expect(TELEGRAM.refusal(message({ id: 148392011, type: 'private' }), 'triage.json')).toBe('refused chat 148392011 (@alice) — to allow it, add "148392011": "<a spore>" to the people of triage.json')
    expect(TELEGRAM.refusal(message({ id: -100, type: 'supergroup', title: 'Payouts' }, { from: { id: 41, first_name: 'Bob' } }), 'triage.json'))
      .toBe('refused the Telegram group "Payouts", chat -100 — to allow it, add "-100": { "spores": ["<a spore>"], "people": ["41"] } to the groups of triage.json')
  })
})

describe('the bot API', () => {
  const answering = (result, { ok = true, status = 200, description, parameters } = {}) => async () =>
    new Response(JSON.stringify({ ok, result, description, parameters }), { status, headers: { 'content-type': 'application/json' } })
  const sending = (asked) => async (url, init) => {
    asked.push({ url, body: init.body instanceof FormData ? init.body : JSON.parse(init.body) })
    return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }))
  }
  const reaching = (fetch) => {
    vi.stubGlobal('fetch', fetch)
    return createTelegram('t')
  }

  afterEach(() => vi.unstubAllGlobals())

  it('refuses to start without a token', () => {
    expect(() => createTelegram(null)).toThrow(/no bot token/)
  })

  it('unwraps what Telegram sends back', async () => {
    const tg = reaching(answering({ username: 'sporebot' }))
    expect(await tg.me()).toEqual({ username: 'sporebot' })
  })

  it('carries Telegram\'s own complaint, and does not retry a refusal', async () => {
    const tg = reaching(answering(null, { ok: false, status: 400, description: 'chat not found' }))
    await expect(tg.say(1, 'x')).rejects.toMatchObject({ type: 'TELEGRAM_FAILED', detail: 'chat not found', retryable: false, context: { status: 400 } })
  })

  it('says how long Telegram asked it to wait', async () => {
    const tg = reaching(answering(null, { ok: false, status: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } }))
    await expect(tg.revise(1, 2, 'x')).rejects.toMatchObject({ retryable: true, context: { status: 429, retryAfter: 7 } })
  })

  it('retries what never reached Telegram', async () => {
    const tg = reaching(async () => { throw new TypeError('fetch failed') })
    await expect(tg.say(1, 'x')).rejects.toMatchObject({ retryable: true, detail: 'fetch failed' })
  })

  it('long polls with an offset, which is what confirms what came before it', async () => {
    const asked = []
    const tg = reaching(sending(asked))
    await tg.updates(17)
    expect(asked[0].body).toMatchObject({ offset: 17, timeout: 30, allowed_updates: ['message', 'callback_query'] })
  })

  it('asks with a keyboard under the question, closes it with an empty one, and answers a press', async () => {
    const asked = []
    const tg = reaching(sending(asked))
    const keyboard = [[{ text: 'Yes', callback_data: 'ap:aaaaaaaaaaaa:yes', style: 'success' }]]
    await tg.ask(5, '<b>Ship</b> it?', keyboard)
    await tg.close(5, 41, '<b>Ship</b> it?\n\n<b>Yes — Ann</b>')
    await tg.answer('q1', 'Yes — recorded')
    await tg.answer('q2', null)
    expect(asked.map(one => [one.url.split('/').at(-1), one.body])).toEqual([
      ['sendMessage', { chat_id: 5, text: '<b>Ship</b> it?', parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: keyboard } }],
      ['editMessageText', { chat_id: 5, message_id: 41, text: '<b>Ship</b> it?\n\n<b>Yes — Ann</b>', parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [] } }],
      ['answerCallbackQuery', { callback_query_id: 'q1', text: 'Yes — recorded' }],
      ['answerCallbackQuery', { callback_query_id: 'q2' }]
    ])
  })

  it('answers a message as a reply to it, still sent when that message is gone, and removes one of its own', async () => {
    const asked = []
    const tg = reaching(sending(asked))
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
    const tg = reaching(sending(asked))
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
    const tg = reaching(sending(asked))
    await tg.document(5, { path: file, mime: 'text/markdown' }, 'data/out/report.md')
    expect(asked[0].url).toMatch(/sendDocument$/)
    expect(asked[0].body.get('chat_id')).toBe('5')
    expect(asked[0].body.get('caption')).toBe('data/out/report.md')
    expect(asked[0].body.get('document').name).toBe('report.md')
    expect(await asked[0].body.get('document').text()).toBe('# report\n')
  })
})
