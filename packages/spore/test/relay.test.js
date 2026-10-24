import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
  announce, backoff, botNames, botPath, createDelivery, credentialOf, credentialVariables,
  loadState, pieces, reactionsOf, reply, routesOf, saveState, statePath, waiting
} from '../src/relay/index.js'

const SPEC = {
  kind: 'chat',
  label: 'Chat',
  fields: ['token', 'rooms', 'react'],
  credentials: ['token'],
  stateFields: [],
  can: { react: true },
  reactions: ['👨‍💻', '💔', '👀'],
  example: '{ "token": "${CHAT_TOKEN}", "rooms": {} }', // eslint-disable-line no-template-curly-in-string
  conversations: {
    rooms: { noun: 'room', id: /^r\d+$/, says: 'which is not a room', fix: 'a room is r and a number', called: 'its number', fields: ['spore', 'details', 'show', 'brief'] }
  }
}

let DIR
let CONFIG
beforeEach(() => {
  DIR = mkdtempSync(resolve(tmpdir(), 'spore-relay-test-'))
  CONFIG = resolve(DIR, 'config.json')
  mkdirSync(resolve(DIR, 'chat'), { recursive: true })
})
afterEach(() => rmSync(DIR, { recursive: true, force: true }))

describe('a bot file', () => {
  const write = (name, raw) => writeFileSync(botPath(SPEC, name, CONFIG), typeof raw === 'string' ? raw : JSON.stringify(raw))

  it('is read into its routing, and refused when it is missing, unreadable or says what spore does not know', () => {
    const path = botPath(SPEC, 'ops', CONFIG)
    expect(() => routesOf(SPEC, path)).toThrow(expect.objectContaining({ type: 'CHAT_NO_BOT', message: expect.stringMatching(/no .*chat\/ops\.json/) }))
    write('ops', '{')
    expect(() => routesOf(SPEC, path)).toThrow(/not readable JSON/)
    write('ops', { token: '${OPS_TOKEN}', rooms: {}, extra: 1 }) // eslint-disable-line no-template-curly-in-string
    expect(() => routesOf(SPEC, path)).toThrow(/a field spore does not know — extra/)
    write('ops', { token: '${OPS_TOKEN}', rooms: { r1: 'triage' } }) // eslint-disable-line no-template-curly-in-string
    expect(routesOf(SPEC, path)).toEqual(new Map([['r1', { spores: ['triage'], details: false, show: null, brief: false, overhear: false, people: null }]]))
  })

  it('takes how a conversation is shown a turn, and refuses a way it does not know or a reaction the platform cannot make', () => {
    const path = botPath(SPEC, 'ops', CONFIG)
    write('ops', { token: '${OPS_TOKEN}', rooms: { r1: { spore: 'triage', show: 'react' }, r2: 'triage' } }) // eslint-disable-line no-template-curly-in-string
    expect([...routesOf(SPEC, path)].map(([room, { show }]) => [room, show])).toEqual([['r1', 'react'], ['r2', null]])
    write('ops', { token: '${OPS_TOKEN}', rooms: { r1: { spore: 'triage', show: 'emoji' } } }) // eslint-disable-line no-template-curly-in-string
    expect(() => routesOf(SPEC, path)).toThrow(/shows r1 as "emoji"/)
    write('ops', { token: '${OPS_TOKEN}', rooms: { r1: { spore: 'triage', show: 'both' } } }) // eslint-disable-line no-template-curly-in-string
    expect(() => routesOf({ ...SPEC, can: { react: false } }, path)).toThrow(/a Chat bot cannot react/)
  })

  it('keeps a conversation brief as its entry says, or as the bot says, and refuses brief beside details', () => {
    const path = botPath(SPEC, 'ops', CONFIG)
    write('ops', { token: '${OPS_TOKEN}', brief: true, rooms: { r1: 'triage', r2: { spore: 'triage', brief: false, details: true } } }) // eslint-disable-line no-template-curly-in-string
    expect([...routesOf(SPEC, path)].map(([room, { brief, details }]) => [room, brief, details])).toEqual([['r1', true, false], ['r2', false, true]])
    write('ops', { token: '${OPS_TOKEN}', rooms: { r1: { spore: 'triage', brief: true }, r2: 'triage' } }) // eslint-disable-line no-template-curly-in-string
    expect([...routesOf(SPEC, path)].map(([room, { brief }]) => [room, brief])).toEqual([['r1', true], ['r2', false]])
    write('ops', { token: '${OPS_TOKEN}', brief: true, rooms: { r1: { spore: 'triage', details: true } } }) // eslint-disable-line no-template-curly-in-string
    expect(() => routesOf(SPEC, path)).toThrow(/gives r1 both brief and details/)
    write('ops', { token: '${OPS_TOKEN}', brief: 'yes', rooms: {} }) // eslint-disable-line no-template-curly-in-string
    expect(() => routesOf(SPEC, path)).toThrow(/has a brief that is not true or false/)
  })

  it('reads conversations many people share as their section declares them, after the platform\'s own fields', () => {
    const SHARED = {
      ...SPEC,
      fields: ['token', 'people', 'halls', 'region'],
      check: (raw, path) => { if (raw.region !== undefined) throw new Error(`${path} has a region`) },
      conversations: {
        people: { noun: 'person', id: /^u\d+$/, says: 'which is not a user', fix: 'a user is u and a number', not: [{ id: /^u0$/, says: 'which is the system', fix: 'u0 is nobody' }], called: 'their number', fields: ['spore', 'details', 'brief'] },
        halls: { noun: 'hall', id: /^h\d+$/, says: 'which is not a hall', fix: 'a hall is h and a number', fields: ['spores', 'people', 'details', 'loud'], flags: ['loud'], one: true, people: { id: /^u\d+$/, says: 'users', example: 'user' } }
      }
    }
    const path = botPath(SHARED, 'ops', CONFIG)
    const token = '${OPS_TOKEN}' // eslint-disable-line no-template-curly-in-string
    write('ops', { token, people: { u1: 'triage' }, halls: { h1: { spores: ['ops'], people: ['*', 'u2'], loud: true } } })
    expect(routesOf(SHARED, path)).toEqual(new Map([
      ['u1', { spores: ['triage'], details: false, show: null, brief: false, overhear: false, people: null }],
      ['h1', { spores: ['ops'], details: false, show: null, brief: false, overhear: false, loud: true, people: ['*', 'u2'] }]
    ]))
    write('ops', { token, region: 'eu', people: {} })
    expect(() => routesOf(SHARED, path)).toThrow(/has a region/)
    write('ops', { token })
    expect(() => routesOf(SHARED, path)).toThrow(/has no people and no halls/)
    write('ops', { token, people: { u0: 'triage' } })
    expect(() => routesOf(SHARED, path)).toThrow(expect.objectContaining({ message: expect.stringMatching(/names "u0" among its people, which is the system/), detail: 'u0 is nobody' }))
    write('ops', { token, people: { u1: { spore: 'triage', token } } })
    expect(() => routesOf(SHARED, path)).toThrow(expect.objectContaining({ detail: 'a person takes spore, details, brief; token is the bot\'s, beside people and halls' }))
    write('ops', { token, halls: { h1: { spores: ['ops', 'qa'], people: ['*'] } } })
    expect(() => routesOf(SHARED, path)).toThrow(/gives hall h1 2 spores/)
    write('ops', { token, halls: { h1: { spores: ['ops'], people: ['bob'] } } })
    expect(() => routesOf(SHARED, path)).toThrow(/has a hall h1 whose people are not users or \*/)
    write('ops', { token, halls: { h1: { spores: ['ops'], people: ['*'], loud: 'yes' } } })
    expect(() => routesOf(SHARED, path)).toThrow(/has a hall h1 whose loud is not true or false/)
  })

  it('reacts with the emoji it names, the others as they come, and refuses one the platform does not take', () => {
    const path = botPath(SPEC, 'ops', CONFIG)
    write('ops', { token: '${OPS_TOKEN}', rooms: {} }) // eslint-disable-line no-template-curly-in-string
    expect(reactionsOf(SPEC, path)).toEqual({ taken: '👨‍💻', failed: '💔' })
    write('ops', { token: '${OPS_TOKEN}', rooms: {}, react: { taken: '👀' } }) // eslint-disable-line no-template-curly-in-string
    expect(reactionsOf(SPEC, path)).toEqual({ taken: '👀', failed: '💔' })
    write('ops', { token: '${OPS_TOKEN}', rooms: {}, react: { failed: '✅' } }) // eslint-disable-line no-template-curly-in-string
    expect(() => reactionsOf(SPEC, path)).toThrow(expect.objectContaining({ type: 'CHAT_BOT_INVALID', message: expect.stringMatching(/reacts with ✅, which Chat does not take/), detail: 'Chat reacts only with 👨‍💻 💔 👀' }))
    write('ops', { token: '${OPS_TOKEN}', rooms: {}, react: { done: '👀' } }) // eslint-disable-line no-template-curly-in-string
    expect(() => reactionsOf(SPEC, path)).toThrow(/has a react spore cannot read/)
    write('ops', { token: '${OPS_TOKEN}', rooms: {}, react: { taken: ':eyes-custom:' } }) // eslint-disable-line no-template-curly-in-string
    expect(reactionsOf({ ...SPEC, reactions: null }, path)).toEqual({ taken: ':eyes-custom:', failed: '💔' })
  })

  it('takes a credential only as the variable holding it, and says which one is not set', () => {
    write('ops', { token: '123:abc', rooms: {} })
    expect(() => routesOf(SPEC, botPath(SPEC, 'ops', CONFIG))).toThrow(/no token spore can read/)
    write('ops', { token: '${OPS_TOKEN}', rooms: {} }) // eslint-disable-line no-template-curly-in-string
    expect(credentialOf(SPEC, botPath(SPEC, 'ops', CONFIG), 'token', { OPS_TOKEN: 't-1' })).toBe('t-1')
    expect(() => credentialOf(SPEC, botPath(SPEC, 'ops', CONFIG), 'token', {})).toThrow(expect.objectContaining({ type: 'CHAT_NO_TOKEN', message: expect.stringMatching(/\$OPS_TOKEN, which is not set/) }))
  })

  it('knows every bot beside the configuration and every variable their credentials are in, refusing one it cannot read', () => {
    write('ops', { token: '${OPS_TOKEN}', rooms: {} }) // eslint-disable-line no-template-curly-in-string
    write('review', { token: '${REVIEW_TOKEN}', rooms: {} }) // eslint-disable-line no-template-curly-in-string
    expect(botNames(SPEC, CONFIG)).toEqual(['ops', 'review'])
    expect(credentialVariables(SPEC, CONFIG)).toEqual(['OPS_TOKEN', 'REVIEW_TOKEN'])
    write('broken', '{')
    expect(() => credentialVariables(SPEC, CONFIG)).toThrow(/not readable JSON/)
  })

  it('refuses a name that is not a bot\'s', () => {
    expect(() => botPath(SPEC, '../x', CONFIG)).toThrow(expect.objectContaining({ type: 'CHAT_BOT_INVALID' }))
  })
})

describe('what of a turn reaches a conversation', () => {
  it('replies with the answer, and with how the turn ended only when that makes it partial', () => {
    expect(reply({ record: { stopReason: 'answer', output: 'done' } })).toBe('done')
    expect(reply({ record: { stopReason: 'question', output: 'which year?' } })).toBe('which year?')
    expect(reply({ record: { stopReason: 'soft:cost', output: 'partial' } })).toBe('partial\n\n— soft:cost')
    expect(reply({ record: { stopReason: 'quiet', output: null } })).toBe('nothing to say')
    expect(reply({ record: { stopReason: 'error', error: 'KILLED', output: null } })).toBe('no answer · error · KILLED')
  })

  it('says where a turn nobody in the conversation asked for came from', () => {
    const turn = (stopReason, output, asked) => ({ record: { stopReason, output }, asked })
    expect(announce(turn('answer', 'two new papers', [{ schedule: 'digest' }]))).toBe('schedule "digest"\n\ntwo new papers')
    expect(announce(turn('answer', 'hi', [{ text: 'from a terminal' }]))).toBe('sent from elsewhere\n\nhi')
    expect(announce(turn('answer', 'triaged', [{ hook: 'forge' }, { hook: 'forge' }]))).toBe('webhook "forge"\n\ntriaged')
    expect(announce(turn('answer', 'both', [{ schedule: 'digest' }, { hook: 'forge' }]))).toBe('schedule "digest" · webhook "forge"\n\nboth')
    expect(announce(turn('answer', 'scanned', [{ job: 'scan' }]))).toBe('job "scan"\n\nscanned')
    expect(announce(turn('answer', 'filed', [{ api: 'pipeline' }]))).toBe('API caller "pipeline"\n\nfiled')
    expect(announce(turn('error', null, [{ schedule: 'digest' }]))).toBe('schedule "digest"\n\nno answer · error')
  })

  it('tells a conversation whose message no turn is going to read yet', () => {
    expect(waiting({ record: { stopReason: 'error', error: 'START_FAILED' } })).toBe('no answer yet · error · START_FAILED — your message waits for the next turn')
  })

  it('tells a brief conversation the answer alone, and nothing of how the turn ended', () => {
    const brief = { brief: true }
    expect(reply({ record: { stopReason: 'soft:cost', output: 'partial' } }, brief)).toBe('partial')
    expect(reply({ record: { stopReason: 'error', error: 'KILLED', output: null } }, brief)).toBe('no answer this time')
    expect(reply({ record: { stopReason: 'quiet', output: null } }, brief)).toBe('nothing to say')
    expect(announce({ record: { stopReason: 'hard:wall', output: null }, asked: [{ schedule: 'digest' }] }, brief)).toBe('no answer this time')
    expect(announce({ record: { stopReason: 'answer', output: 'tried again' }, asked: [{ schedule: 'digest' }] }, brief)).toBe('tried again')
    expect(waiting({ record: { stopReason: 'error', error: 'START_FAILED' } }, brief)).toBe('no answer yet — your message waits for the next turn')
  })

  it('breaks a long answer at a line, or at the limit when there is none', () => {
    expect(pieces('a'.repeat(3000) + '\n' + 'b'.repeat(2000), 4096)).toEqual(['a'.repeat(3000), 'b'.repeat(2000)])
    expect(pieces('x'.repeat(4106), 4096).map(piece => piece.length)).toEqual([4096, 10])
    expect(pieces('hello', 4096)).toEqual(['hello'])
  })

  it('closes a code block a piece ends inside, and opens it again with its language in the next', () => {
    const code = 'intro\n```js\n' + Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\n') + '\n```\nafter'
    expect(pieces(code, 30)).toEqual([
      'intro\n```js\nline 0\nline 1\n```',
      '```js\nline 2\nline 3\nline 4\n```',
      '```js\nline 5\n```\nafter'
    ])
    expect(pieces('~~~\n' + 'x\n'.repeat(20) + '~~~', 20).every(piece => piece.length <= 20 && piece.startsWith('~~~') && /~~~$/.test(piece))).toBe(true)
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

  it('waits as long as the platform asked, then tries again', async () => {
    const waited = []
    const delivery = createDelivery({ sleep: async (ms) => { waited.push(ms) }, signal: new AbortController().signal })
    const calls = await delivery.to('1', attempt => attempt(failing(2, retryable(3))))
    expect(calls).toBe(3)
    expect(waited).toEqual([3000, 3000])
  })

  it('does not retry a refusal', async () => {
    const delivery = createDelivery({ sleep: async () => {}, signal: new AbortController().signal })
    const refused = Object.assign(new Error('chat not found'), { retryable: false })
    await expect(delivery.to('1', attempt => attempt(failing(1, refused)))).rejects.toBe(refused)
  })

  it('gives up once it is stopping, without trying again', async () => {
    const stopping = new AbortController()
    const delivery = createDelivery({ sleep: async () => stopping.abort(), signal: stopping.signal })
    await expect(delivery.to('1', attempt => attempt(failing(1, retryable())))).rejects.toThrow('busy')
  })

  it('keeps a conversation\'s order, even past a step that failed', async () => {
    const order = []
    const delivery = createDelivery({ sleep: async () => {}, signal: new AbortController().signal })
    const first = delivery.to('1', async () => { await new Promise(resolve => setTimeout(resolve, 20)); order.push('first'); throw new Error('lost') })
    const second = delivery.to('1', async () => { order.push('second') })
    await expect(first).rejects.toThrow('lost')
    await second
    expect(order).toEqual(['first', 'second'])
  })

  it('backs off from a second, doubling to a minute, unless the platform names a wait, and starts over once a try worked', () => {
    const retry = backoff()
    const waits = [retry.after(), retry.after(), retry.after(retryable(5)), ...Array.from({ length: 5 }, () => retry.after())]
    expect(waits).toEqual([1000, 2000, 5000, 8000, 16_000, 32_000, 60_000, 60_000])
    retry.reset()
    expect(retry.after(new Error('lost'))).toBe(1000)
  })
})

describe('where a bot stands', () => {
  it('lives under XDG_STATE_HOME, one place per bot', () => {
    expect(statePath('chat', 'review', { XDG_STATE_HOME: '/s' })).toBe('/s/spore/chat/review/state.json')
  })

  it('starts empty, and reads back what it wrote, its owner\'s alone', () => {
    const file = resolve(DIR, 'kept/state.json')
    expect(loadState(file, SPEC)).toEqual({ cursors: {}, pending: {} })
    const state = { cursors: { '/ws': { seq: 4, turn: 2 } }, pending: { '/ws': [{ inbox: 3, conversation: '1', asked: 7, note: 9 }] } }
    saveState(file, state, SPEC)
    expect(loadState(file, SPEC)).toEqual(state)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(resolve(DIR, 'kept')).mode & 0o777).toBe(0o700)
  })

  it('refuses a file it cannot read, or a message it waits on that names no conversation, rather than starting from nothing', () => {
    const file = resolve(DIR, 'state.json')
    writeFileSync(file, '{ half')
    expect(() => loadState(file, SPEC)).toThrow(expect.objectContaining({ type: 'CHAT_STATE_INVALID' }))
    writeFileSync(file, JSON.stringify({ cursors: {}, pending: { '/ws': [{ inbox: 3, chat: 1, message: 9 }] } }))
    expect(() => loadState(file, SPEC)).toThrow(expect.objectContaining({ type: 'CHAT_STATE_INVALID', detail: expect.stringMatching(/earlier version/) }))
  })
})
