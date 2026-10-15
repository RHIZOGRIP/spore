import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import {
  announce, botNames, botPath, createDelivery, credentialOf, credentialVariables, describe as describeCall,
  loadState, pieces, reactionsOf, render, reply, routesOf, saveState, statePath, track, waiting
} from '../src/relay/index.js'

const SPEC = {
  kind: 'chat',
  label: 'Chat',
  fields: ['token', 'rooms', 'react'],
  credentials: ['token'],
  stateFields: [],
  can: { react: true },
  reactions: ['🫡', '💔', '👀'],
  example: '{ "token": "${CHAT_TOKEN}", "rooms": {} }', // eslint-disable-line no-template-curly-in-string
  routes: (raw) => new Map(Object.entries(raw.rooms).map(([room, entry]) => [room, { spores: [entry.spore ?? entry], details: false, show: entry.show ?? null }]))
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
    expect(routesOf(SPEC, path)).toEqual(new Map([['r1', { spores: ['triage'], details: false, show: null }]]))
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

  it('reacts with the emoji it names, the others as they come, and refuses one the platform does not take', () => {
    const path = botPath(SPEC, 'ops', CONFIG)
    write('ops', { token: '${OPS_TOKEN}', rooms: {} }) // eslint-disable-line no-template-curly-in-string
    expect(reactionsOf(SPEC, path)).toEqual({ taken: '🫡', failed: '💔' })
    write('ops', { token: '${OPS_TOKEN}', rooms: {}, react: { taken: '👀' } }) // eslint-disable-line no-template-curly-in-string
    expect(reactionsOf(SPEC, path)).toEqual({ taken: '👀', failed: '💔' })
    write('ops', { token: '${OPS_TOKEN}', rooms: {}, react: { failed: '✅' } }) // eslint-disable-line no-template-curly-in-string
    expect(() => reactionsOf(SPEC, path)).toThrow(expect.objectContaining({ type: 'CHAT_BOT_INVALID', message: expect.stringMatching(/reacts with ✅, which Chat does not take/), detail: 'Chat reacts only with 🫡 💔 👀' }))
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

  it('shows a conversation that asked for details the command or the path, spore\'s programs by name', () => {
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

  it('tells a command that said no apart from a call that failed', () => {
    const events = [
      start('exec', { command: 'grep -q x a' }, 'a'),
      { event: 'tool_end', name: 'exec', callId: 'a', durationMs: 10, error: true, outcome: 'exit', exit: 1 },
      start('exec', { command: 'sleep 999' }, 'b'),
      { event: 'tool_end', name: 'exec', callId: 'b', durationMs: 10, error: true, outcome: 'killed', killed: 'idle' },
      start('read', { path: 'a' }, 'c'),
      { event: 'tool_end', name: 'read', callId: 'c', durationMs: 10, error: false, outcome: 'ok' }
    ]
    expect(shown(events)).toEqual(['· running a command — exit 1', '· running a command — failed', '· reading a file'])
  })

  it('shows nothing of an event a conversation has no use for', () => {
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

  it('says where a turn nobody in the conversation asked for came from', () => {
    const turn = (stopReason, output, asked) => ({ record: { stopReason, output }, asked })
    expect(announce(turn('answer', 'two new papers', [{ schedule: 'digest' }]))).toBe('schedule "digest"\n\ntwo new papers')
    expect(announce(turn('answer', 'hi', [{ text: 'from a terminal' }]))).toBe('sent from elsewhere\n\nhi')
    expect(announce(turn('answer', 'triaged', [{ hook: 'forge' }, { hook: 'forge' }]))).toBe('webhook "forge"\n\ntriaged')
    expect(announce(turn('answer', 'both', [{ schedule: 'digest' }, { hook: 'forge' }]))).toBe('schedule "digest" · webhook "forge"\n\nboth')
    expect(announce(turn('answer', 'scanned', [{ job: 'scan' }]))).toBe('job "scan"\n\nscanned')
    expect(announce(turn('error', null, [{ schedule: 'digest' }]))).toBe('schedule "digest"\n\nno answer · error')
  })

  it('tells a conversation whose message no turn is going to read yet', () => {
    expect(waiting({ record: { stopReason: 'error', error: 'START_FAILED' } })).toBe('no answer yet · error · START_FAILED — your message waits for the next turn')
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
