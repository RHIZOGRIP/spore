import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { createTelegram } from '../src/api.js'
import { announce, describe as describeCall, pieces, render, reply, track, waiting, MAX_MESSAGE } from '../src/forward.js'
import { allowed, botNames, botPath, botToken, detailedChats, tokenVariables } from '../src/bots.js'
import { createDelivery } from '../src/delivery.js'
import { loadState, saveState, statePath } from '../src/state.js'

let DIR
let CONFIG
let path
const chats = (table) => writeFileSync(path, JSON.stringify({ token: '${TRIAGE_BOT_TOKEN}', chats: table })) // eslint-disable-line no-template-curly-in-string

beforeEach(() => {
  DIR = mkdtempSync(resolve(tmpdir(), 'spore-telegram-test-'))
  CONFIG = resolve(DIR, 'config.json')
  path = botPath('triage', CONFIG)
  mkdirSync(resolve(DIR, 'telegram'), { recursive: true })
})
afterEach(() => rmSync(DIR, { recursive: true, force: true }))

describe('a bot: its token, who may talk to it, and to which spore', () => {
  it('reads a chat id against the spore it reaches', () => {
    chats({ 148392011: 'triage', '-1001234567': 'standup' })
    expect(allowed(path)).toEqual({ 148392011: 'triage', '-1001234567': 'standup' })
  })

  it('refuses to run without its file, rather than treating it as empty', () => {
    expect(() => allowed(path)).toThrow(/no .*telegram\/triage\.json/)
  })

  it('refuses an entry that does not name a spore', () => {
    chats({ 1: 42 })
    expect(() => allowed(path)).toThrow(/not a spore/)
  })

  it('refuses a file it cannot read as JSON', () => {
    writeFileSync(path, 'chats: [oops]')
    expect(() => allowed(path)).toThrow(/not readable JSON/)
  })

  it('takes a chat that asks for details, and says which chats did', () => {
    chats({ 1: { spore: 'triage', details: true }, 2: 'triage', 3: { spore: 'triage' } })
    expect(allowed(path)).toEqual({ 1: 'triage', 2: 'triage', 3: 'triage' })
    expect([...detailedChats(path)]).toEqual([1])
  })

  it('refuses an entry with a field it does not know', () => {
    chats({ 1: { spore: 'triage', detail: true } })
    expect(() => allowed(path)).toThrow(/not a spore/)
  })

  it('lets two chats reach one spore', () => {
    chats({ 1: 'shared', 2: 'shared' })
    expect(Object.values(allowed(path))).toEqual(['shared', 'shared'])
  })

  it('reads its token from the variable it names, and refuses a token written in the file', () => {
    chats({})
    expect(botToken(path, { TRIAGE_BOT_TOKEN: 't-1' })).toBe('t-1')
    expect(() => botToken(path, {})).toThrow(/\$TRIAGE_BOT_TOKEN, which is not set/)
    writeFileSync(path, JSON.stringify({ token: '123:abc', chats: {} }))
    expect(() => allowed(path)).toThrow(/no token spore can read/)
  })

  it('knows every bot beside the configuration, and every variable their tokens are in', () => {
    chats({})
    writeFileSync(botPath('review', CONFIG), JSON.stringify({ token: '${REVIEW_BOT_TOKEN}', chats: {} })) // eslint-disable-line no-template-curly-in-string
    expect(botNames(CONFIG)).toEqual(['review', 'triage'])
    expect(tokenVariables(CONFIG)).toEqual(['REVIEW_BOT_TOKEN', 'TRIAGE_BOT_TOKEN'])
    writeFileSync(botPath('broken', CONFIG), '{')
    expect(() => tokenVariables(CONFIG)).toThrow(/not readable JSON/)
  })
})

describe('the bot API', () => {
  const answering = (result, { ok = true, status = 200, description, parameters } = {}) => async () =>
    new Response(JSON.stringify({ ok, result, description, parameters }), { status, headers: { 'content-type': 'application/json' } })

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
    let asked
    const tg = createTelegram('t', {
      fetchImpl: async (url, init) => { asked = JSON.parse(init.body); return new Response(JSON.stringify({ ok: true, result: [] })) }
    })
    await tg.updates(17)
    expect(asked).toMatchObject({ offset: 17, timeout: 30, allowed_updates: ['message'] })
  })

  it('uploads a document under its own name', async () => {
    const file = resolve(DIR, 'report.md')
    writeFileSync(file, '# report\n')
    let sent
    const tg = createTelegram('t', { fetchImpl: async (url, init) => { sent = { url, body: init.body }; return new Response(JSON.stringify({ ok: true, result: {} })) } })
    await tg.document(5, { path: file, mime: 'text/markdown' }, 'data/out/report.md')
    expect(sent.url).toMatch(/sendDocument$/)
    expect(sent.body.get('chat_id')).toBe('5')
    expect(sent.body.get('caption')).toBe('data/out/report.md')
    expect(sent.body.get('document').name).toBe('report.md')
    expect(await sent.body.get('document').text()).toBe('# report\n')
  })
})

describe('what of a turn reaches a chat', () => {
  const start = (name, args, callId = 'c1') => ({ event: 'tool_start', name, args, callId })
  const shown = (events, options) => {
    const items = []
    for (const event of events) track(items, event)
    return render(items, options)
  }

  it('says what kind of call ran, and never what it was given', () => {
    const events = [
      start('read', { path: 'data/secret-client.pdf' }, 'a'),
      start('exec', { command: 'grep -r secret /etc' }, 'b'),
      start('wsexec', { command: 'node "$SPORE_SOURCE" forgejo --path api/v1/repos/acme/x --out data/x.json' }, 'c'),
      start('exec', { command: '"$SPORE_BRAVE" acme merger rumours', out: 'data/s.txt' }, 'd')
    ]
    const lines = shown(events)
    expect(lines).toEqual(['· reading a file', '· running a command', '· asking forgejo', '· searching the web'])
    expect(lines.join('\n')).not.toMatch(/secret|acme|etc|api/)
  })

  it('shows a chat that asked for details the command or the path, spore\'s programs by name', () => {
    const events = [
      start('read', { path: 'data/report.md' }, 'a'),
      start('wsexec', { command: 'node "$SPORE_SOURCE" forgejo --path api/v1/repos/acme/x/issues --out data/x.json' }, 'b'),
      start('exec', { command: 'git log --oneline -5\ngit status' }, 'c')
    ]
    expect(shown(events, { detailed: true })).toEqual([
      '· reading data/report.md',
      '· source forgejo --path api/v1/repos/acme/x/issues --out data/x.json',
      '· running git log --oneline -5'
    ])
  })

  it('counts a run of the same call, and says when one was slow or failed', () => {
    const events = [
      start('read', { path: 'a' }, 'a'), start('read', { path: 'b' }, 'b'), start('read', { path: 'c' }, 'c'),
      start('exec', { command: 'sleep 20' }, 'd'),
      { event: 'tool_end', name: 'exec', callId: 'd', durationMs: 14_200, error: false },
      start('exec', { command: 'false' }, 'e'),
      { event: 'tool_end', name: 'exec', callId: 'e', durationMs: 10, error: true, result: '/home/me/.ssh/id_ed25519' }
    ]
    expect(shown(events)).toEqual(['· reading a file ×3', '· running a command — 14 s', '· running a command — failed'])
  })

  it('shows nothing of an event a chat has no use for', () => {
    expect(shown([{ event: 'round', index: 3 }, { event: 'complete', output: 'the answer' }, start('quiet', { because: 'x' })])).toEqual([])
    expect(describeCall({ name: 'ask', args: { question: 'which?' } })).toBe(null)
  })

  it('replies with the answer, and with how the turn ended only when that makes it partial', () => {
    expect(reply({ record: { stopReason: 'answer', output: 'done' } })).toBe('done')
    expect(reply({ record: { stopReason: 'question', output: 'which year?' } })).toBe('which year?')
    expect(reply({ record: { stopReason: 'soft:cost', output: 'partial' } })).toBe('partial\n\n— soft:cost')
    expect(reply({ record: { stopReason: 'quiet', output: null } })).toBe('nothing to say')
    expect(reply({ record: { stopReason: 'error', error: 'KILLED', output: null } })).toBe('no answer · error · KILLED')
  })

  it('says where a turn nobody in the chat asked for came from', () => {
    const turn = (stopReason, output, asked) => ({ record: { stopReason, output }, asked })
    expect(announce(turn('answer', 'two new papers', [{ schedule: 'digest' }]))).toBe('schedule "digest"\n\ntwo new papers')
    expect(announce(turn('answer', 'hi', [{ text: 'from a terminal' }]))).toBe('sent from elsewhere\n\nhi')
    expect(announce(turn('answer', 'triaged', [{ hook: 'forge' }, { hook: 'forge' }]))).toBe('webhook "forge"\n\ntriaged')
    expect(announce(turn('answer', 'both', [{ schedule: 'digest' }, { hook: 'forge' }]))).toBe('schedule "digest" · webhook "forge"\n\nboth')
    expect(announce(turn('answer', 'scanned', [{ job: 'scan' }]))).toBe('job "scan"\n\nscanned')
    expect(announce(turn('error', null, [{ schedule: 'digest' }]))).toBe('schedule "digest"\n\nno answer · error')
  })

  it('tells a chat whose message no turn is going to read yet', () => {
    expect(waiting({ record: { stopReason: 'error', error: 'START_FAILED' } })).toBe('no answer yet · error · START_FAILED — your message waits for the next turn')
  })

  it('breaks a long answer at a line, or at the limit when there is none', () => {
    expect(pieces('a'.repeat(3000) + '\n' + 'b'.repeat(2000))).toEqual(['a'.repeat(3000), 'b'.repeat(2000)])
    const out = pieces('x'.repeat(MAX_MESSAGE + 10))
    expect(out.map(p => p.length)).toEqual([MAX_MESSAGE, 10])
    expect(pieces('hello')).toEqual(['hello'])
  })
})

describe('delivery', () => {
  const failing = (times, error) => {
    let calls = 0
    return async () => {
      calls += 1
      if (calls <= times) throw error
      return calls
    }
  }
  const retryable = (retryAfter = null) => Object.assign(new Error('busy'), { retryable: true, context: { retryAfter } })

  it('waits as long as Telegram asked, then tries again', async () => {
    const waited = []
    const delivery = createDelivery({ sleep: async (ms) => { waited.push(ms) }, signal: new AbortController().signal })
    const calls = await delivery.to(1, attempt => attempt(failing(2, retryable(3))))
    expect(calls).toBe(3)
    expect(waited).toEqual([3000, 3000])
  })

  it('does not retry a refusal', async () => {
    const delivery = createDelivery({ sleep: async () => {}, signal: new AbortController().signal })
    const refused = Object.assign(new Error('chat not found'), { retryable: false })
    await expect(delivery.to(1, attempt => attempt(failing(1, refused)))).rejects.toBe(refused)
  })

  it('gives up once it is stopping', async () => {
    const stopping = new AbortController()
    const delivery = createDelivery({ sleep: async () => stopping.abort(), signal: stopping.signal })
    await expect(delivery.to(1, attempt => attempt(failing(5, retryable())))).rejects.toThrow('busy')
  })

  it('keeps a chat\'s order, even past a step that failed', async () => {
    const order = []
    const delivery = createDelivery({ sleep: async () => {}, signal: new AbortController().signal })
    const first = delivery.to(1, async () => { await new Promise(resolve => setTimeout(resolve, 20)); order.push('first'); throw new Error('lost') })
    const second = delivery.to(1, async () => { order.push('second') })
    await expect(first).rejects.toThrow('lost')
    await second
    expect(order).toEqual(['first', 'second'])
  })
})

describe('where the bot stands', () => {
  it('lives under XDG_STATE_HOME, one place per bot', () => {
    expect(statePath('review', { XDG_STATE_HOME: '/s' })).toBe('/s/spore/telegram/review/state.json')
  })

  it('starts empty, and reads back what it wrote', () => {
    const file = resolve(DIR, 'nested/state.json')
    expect(loadState(file)).toEqual({ cursors: {}, pending: {} })
    const state = { cursors: { '/ws': { seq: 4, turn: 2 } }, pending: { '/ws': [{ inbox: 3, chat: 1, message: 9 }] } }
    saveState(file, state)
    expect(loadState(file)).toEqual(state)
  })

  it('refuses a file it cannot read rather than starting from nothing', () => {
    const file = resolve(DIR, 'state.json')
    writeFileSync(file, '{ half')
    expect(() => loadState(file)).toThrow(expect.objectContaining({ type: 'TELEGRAM_STATE_INVALID' }))
  })
})
