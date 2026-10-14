/**
 * The Telegram service against real spores: runners, the agent, confinement and the records
 * are real; Telegram is a stand-in and the model's replies are scripted.
 */

import './fixtures/own-config.js'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { createModelServer } from './fixtures/model-server.js'
import { answers, calls, scriptedMo } from './fixtures/scripted-model.js'
import { outsideRoot } from './fixtures/outside-ws.js'
import { brokerSocketPath } from '../src/infra/broker-socket.js'
import { definitionWith } from '../src/core/identity-defaults.js'
import { outbox, readInbox, readLock, readTurns, statePath as databaseOf } from '../src/core/spore-dir.js'
import { CONFIG_FILE } from '../src/library/config.js'
import { send } from '../src/core/send.js'
import { RUNNING, stateOf, stop } from '../src/core/state.js'
import { SporeError } from '../src/index.js'
import { createService } from '@rhizogrip/spore-plugin-telegram/src/service.js'

let root
let home
let ws
let configFile
let saved
let broker
let reply
let tg
let logs
let env
let release
let tests = 0
const running = []

const until = async (done, limitMs = 15000) => {
  const deadline = Date.now() + limitMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('waited too long')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const idle = (turns) => until(() => readTurns(ws).length === turns && stateOf(ws).state !== RUNNING)

const standIn = ({ onPoll = () => {} } = {}) => {
  const waiting = []
  const sent = []
  const faults = []
  let id = 100
  let wake = null
  const fault = (op) => {
    const found = faults.find(f => f.op === op && f.times > 0)
    if (!found) return
    found.times -= 1
    throw found.error
  }
  return {
    sent,
    push: (update) => { waiting.push(update); wake?.() },
    fail: (op, error, times = 1) => faults.push({ op, error, times }),
    updates: async (offset, { signal, seconds } = {}) => {
      fault('updates')
      onPoll(offset)
      if (offset !== undefined) while (waiting.length && waiting[0].update_id < offset) waiting.shift()
      if (!waiting.length && seconds !== 0) {
        await new Promise(resolve => {
          wake = resolve
          signal?.addEventListener('abort', resolve, { once: true })
        })
        wake = null
        if (signal?.aborted) throw new Error('aborted')
      }
      return [...waiting]
    },
    say: async (chat, text) => {
      fault('say')
      id += 1
      sent.push({ op: 'say', chat, text, message: id })
      return { message_id: id }
    },
    revise: async (chat, message, text) => {
      fault('revise')
      sent.push({ op: 'revise', chat, message, text })
      return true
    },
    document: async (chat, file, caption) => {
      fault('document')
      sent.push({ op: 'document', chat, path: file.path, caption })
      return {}
    },
    me: async () => ({ username: 'sporebot' })
  }
}

const message = (update, chat, text) => ({ update_id: update, message: { chat: { id: chat }, from: { username: `u${chat}` }, text } })

const start = (opts = {}) => {
  const controller = new AbortController()
  const service = createService({
    telegram: tg,
    botFile: join(root, 'telegram', 'triage.json'),
    statePath: saved,
    env,
    log: (line) => logs.push(line),
    configFile,
    sleep: () => new Promise(resolve => setTimeout(resolve, 5)),
    editEveryMs: 50,
    followEveryMs: 100,
    ...opts
  })
  const done = service.run(controller.signal)
  const handle = { done, stop: async () => { controller.abort(); await done } }
  running.push(handle)
  return handle
}

const routes = (table) => {
  mkdirSync(join(root, 'telegram'), { recursive: true })
  writeFileSync(join(root, 'telegram', 'triage.json'), JSON.stringify({ token: '${TRIAGE_BOT_TOKEN}', chats: table })) // eslint-disable-line no-template-curly-in-string
  writeFileSync(join(root, 'telegram', 'other.json'), JSON.stringify({ token: '${OTHER_BOT_TOKEN}', chats: {} })) // eslint-disable-line no-template-curly-in-string
}
const defaultReplyTo = (place) => {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify({ replyTo: { triage: place } }))
}
const savedState = () => (existsSync(saved) ? JSON.parse(readFileSync(saved, 'utf8')) : { cursors: {}, pending: {} })
const said = (chat) => tg.sent.filter(s => s.chat === chat)
const noteOf = (chat) => said(chat).find(s => s.op === 'say' && /working/.test(s.text))
const lastText = (chat, note) => said(chat).filter(s => s.message === note.message).at(-1).text
const answerOf = (chat) => {
  const note = noteOf(chat)
  return note && lastText(chat, note)
}
const retryable = (status, retryAfter) => new SporeError('telegram failed', { type: 'TELEGRAM_FAILED', retryable: true, detail: 'Too Many Requests', context: { status, retryAfter } })
const refused = (detail) => new SporeError('telegram failed', { type: 'TELEGRAM_FAILED', retryable: false, detail, context: { status: 400, retryAfter: null } })

beforeEach(async () => {
  root = outsideRoot('telegram-service')
  home = join(root, 'home')
  ws = join(home, 'triage')
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'spore.cmk'), definitionWith('anthropic/claude-haiku-4-5'))
  configFile = join(root, 'config.json')
  writeFileSync(configFile, JSON.stringify({ home }))
  saved = join(root, 'state', 'telegram.json')
  routes({ 1: 'triage' })
  logs = []
  release = null
  tg = standIn()
  reply = async () => answers('hello back')
  tests += 1
  broker = createModelServer({ mo: scriptedMo((input, round, options) => reply(input, round, options)), socketPath: brokerSocketPath(`tg-service-${tests}`), limit: 10 })
  await broker.listen()
  env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    SPORE_MODEL_SOCKET: broker.socketPath,
    TRIAGE_BOT_TOKEN: 'the-bot-token',
    OTHER_BOT_TOKEN: 'another-bot-token'
  }
})

afterEach(async () => {
  const test = { root, ws, broker }
  release?.()
  await Promise.allSettled(running.splice(0).map(handle => handle.stop()))
  if (stateOf(test.ws).state === RUNNING) stop(test.ws)
  await until(() => stateOf(test.ws).state !== RUNNING, 20_000)
  await test.broker.close()
  rmSync(test.root, { recursive: true, force: true })
  rmSync(CONFIG_FILE, { force: true })
}, 30_000)

describe('a message from a chat', () => {
  it('is answered in its own working message, by a runner that holds no bot\'s token', async () => {
    let environ = null
    reply = async () => {
      environ = readFileSync(`/proc/${readLock(ws).pid}/environ`, 'utf8')
      return answers('hello back')
    }
    start()
    tg.push(message(1, 1, 'hello'))

    await until(() => answerOf(1) === 'hello back')
    expect(said(1).filter(s => s.op === 'say').map(s => s.text)).toEqual(['working…'])
    expect(environ).toContain('SPORE_MODEL_SOCKET=')
    expect(environ).not.toContain('TRIAGE_BOT_TOKEN')
    expect(environ).not.toContain('OTHER_BOT_TOKEN')
  })

  it('reaches its turn with a key added to the environment file after the service started', async () => {
    let environ = null
    reply = async () => {
      environ = readFileSync(`/proc/${readLock(ws).pid}/environ`, 'utf8')
      return answers('hello back')
    }
    start()
    writeFileSync(join(root, 'environment'), 'LATE_KEY=added-after\nOTHER_BOT_TOKEN=from-the-file\n')
    tg.push(message(1, 1, 'hello'))

    await until(() => answerOf(1) === 'hello back')
    expect(environ).toContain('LATE_KEY=added-after')
    expect(environ).not.toContain('OTHER_BOT_TOKEN')
  })

  it('never shows an earlier answer for a turn that has none', async () => {
    reply = async (input, round) => (round === 0 ? answers('first') : calls('quiet', { because: 'nothing new' }))
    start()
    tg.push(message(1, 1, 'one'))
    await until(() => tg.sent.some(s => s.op === 'revise' && s.text === 'first'))
    await idle(1)

    tg.push(message(2, 1, 'two'))
    await idle(2)
    const notes = said(1).filter(s => s.op === 'say')
    expect(notes).toHaveLength(2)
    await until(() => /^no answer · /.test(lastText(1, notes[1])))
  })

  it('is taken once when Telegram hands it over twice', async () => {
    start()
    tg.push(message(7, 1, 'hello'))
    tg.push(message(7, 1, 'hello'))
    await until(() => answerOf(1) === 'hello back')
    await idle(1)
    expect(readInbox(ws)).toHaveLength(1)
    expect(said(1).filter(s => s.op === 'say')).toHaveLength(1)
  })

  it('is confirmed to Telegram only once the spore has it', async () => {
    const seen = []
    tg = standIn({ onPoll: (offset) => seen.push({ offset, inbox: readInbox(ws).length }) })
    start()
    tg.push(message(11, 1, 'hello'))
    await until(() => seen.some(p => p.offset === 12))
    expect(seen.find(p => p.offset === 12).inbox).toBe(1)
  })

  it('that the spore refuses is told to the chat', async () => {
    start()
    tg.push(message(1, 1, 'hello'))
    await idle(1)
    chmodSync(databaseOf(ws), 0o444)
    try {
      tg.push(message(2, 1, 'again'))
      await until(() => said(1).some(s => /^not delivered — /.test(s.text)))
      expect(logs.some(line => /INBOX_UNWRITABLE/.test(line))).toBe(true)
    } finally {
      chmodSync(databaseOf(ws), 0o644)
    }
  })

  it('from a chat nobody allowed gets silence, and the log says how to allow it', async () => {
    start()
    tg.push(message(1, 99, 'hello'))
    await until(() => logs.some(line => line.startsWith('refused chat 99 (@u99)')))
    expect(said(99)).toEqual([])
    expect(readInbox(ws)).toEqual([])
  })

  it('shows a chat that asked for details the command itself, and no other chat', async () => {
    routes({ 1: { spore: 'triage', details: true }, 2: 'triage' })
    reply = async (input, round) => round === 0
      ? calls('wsexec', { command: 'echo checked > data/check.txt', out: 'data/log.txt' })
      : answers('checked')
    start()
    tg.push(message(1, 1, 'check'))
    await until(() => answerOf(1) === 'checked')
    expect(said(1).some(s => s.text?.includes('· running echo checked > data/check.txt'))).toBe(true)
  })

  it('shows the tools at work, and hands back what the turn put in data/out', async () => {
    reply = async (input, round) => round === 0
      ? calls('wsexec', { command: 'mkdir -p data/out && echo report > data/out/report.md && echo done', out: 'data/log.txt' })
      : answers('wrote it')
    start()
    tg.push(message(1, 1, 'write me a report'))
    await until(() => said(1).some(s => s.op === 'document'))

    const note = noteOf(1)
    expect(said(1).some(s => s.message === note.message && s.text.includes('· running a command'))).toBe(true)
    expect(said(1).some(s => s.text?.includes('mkdir'))).toBe(false)
    expect(lastText(1, note)).toBe('wrote it')
    expect(said(1).at(-1)).toMatchObject({ op: 'document', path: join(ws, 'data/out/report.md'), caption: 'data/out/report.md' })
  })

  it('says how many files it did not hand back, past the cap', async () => {
    reply = async (input, round) => round === 0
      ? calls('wsexec', { command: 'mkdir -p data/out && for i in $(seq 52); do echo $i > data/out/f$i.txt; done', out: 'data/log.txt' })
      : answers('wrote them')
    start()
    tg.push(message(1, 1, 'write them all'))
    await until(() => said(1).some(s => s.text?.startsWith('and 2 more')))

    expect(said(1).filter(s => s.op === 'document')).toHaveLength(50)
    expect(said(1).at(-1).text).toBe("and 2 more files in data/out/, in the spore's workspace")
  })
})

describe('delivering to Telegram', () => {
  it('waits out a rate limit, and sends anew what it cannot edit', async () => {
    const waited = []
    tg.fail('revise', retryable(429, 1))
    start({ sleep: (ms) => { waited.push(ms); return new Promise(resolve => setTimeout(resolve, 5)) } })
    tg.push(message(1, 1, 'one'))
    await until(() => answerOf(1) === 'hello back')
    expect(waited).toContain(1000)
    await idle(1)

    tg.fail('revise', refused('Bad Request: message to edit not found'))
    reply = async () => answers('second answer')
    tg.push(message(2, 1, 'two'))
    await until(() => said(1).some(s => s.op === 'say' && s.text === 'second answer'))
    expect(logs.some(line => /cannot be edited/.test(line))).toBe(true)
  })

  it('refuses to share a bot with another process', async () => {
    tg.fail('updates', Object.assign(refused('Conflict: terminated by other getUpdates request'), { context: { status: 409, retryAfter: null } }))
    const handle = start()
    await expect(handle.done).rejects.toMatchObject({ type: 'TELEGRAM_CONFLICT' })
  })
})

describe('turns nobody in a chat started', () => {
  it('reach the spore\'s default chat alone when a schedule fires, and nothing when the turn is quiet', async () => {
    routes({ 1: 'triage', 2: 'triage' })
    defaultReplyTo('telegram:triage/1')
    reply = async (input, round) => (round === 0 ? answers('two new papers') : calls('quiet', { because: 'no change' }))
    start()
    await until(() => savedState().cursors[ws])

    send(ws, 'Check.', { schedule: { name: 'digest', due: '2026-09-28T07:00:00Z' }, env })
    await until(() => said(1).some(s => s.text === 'schedule "digest"\n\ntwo new papers'))

    send(ws, 'Check again.', { schedule: { name: 'digest', due: '2026-09-28T08:00:00Z' }, env })
    await idle(2)
    await until(() => savedState().cursors[ws].turn === 2)
    expect(tg.sent).toHaveLength(1)
    expect(said(2)).toEqual([])
    expect(outbox(ws).map(entry => [entry.recipient, entry.state])).toEqual([['telegram:triage/1', 'delivered']])
  })

  it('reach no chat when a terminal asked, since the terminal follows the turn itself', async () => {
    defaultReplyTo('telegram:triage/1')
    start()
    await until(() => savedState().cursors[ws])

    send(ws, 'from a terminal', { replyTo: 'terminal', env })
    await idle(1)
    await until(() => savedState().cursors[ws].turn === 1)
    expect(tg.sent).toEqual([])
  })

  it('are refused for a chat that does not reach the spore, and for one Telegram will not take', async () => {
    defaultReplyTo('telegram:triage/3')
    start()
    await until(() => savedState().cursors[ws])

    send(ws, 'Check.', { schedule: { name: 'digest', due: '2026-09-28T07:00:00Z' }, env })
    await until(() => outbox(ws).some(entry => entry.state === 'refused'))
    expect(outbox(ws)[0].reason).toMatch(/^chat 3 does not reach this spore/)
    expect(tg.sent).toEqual([])
    await idle(1)

    defaultReplyTo('telegram:triage/1')
    tg.fail('say', refused('Forbidden: bot was blocked by the user'))
    send(ws, 'Check again.', { schedule: { name: 'digest', due: '2026-09-28T08:00:00Z' }, env })
    await until(() => outbox(ws).filter(entry => entry.state === 'refused').length === 2)
    expect(outbox(ws)[1].reason).toMatch(/blocked/)
  })
})

describe('a restart', () => {
  it('in the middle of a turn still finishes the reply', async () => {
    const gate = new Promise(resolve => { release = resolve })
    reply = async () => { await gate; return answers('late answer') }
    const first = start()
    tg.push(message(1, 1, 'take your time'))
    await until(() => savedState().pending[ws]?.[0]?.message)
    await first.stop()

    start()
    release()
    await until(() => answerOf(1) === 'late answer')
    await until(() => Object.keys(savedState().pending).length === 0)
  })

  it('posts a turn that ended while the service was down', async () => {
    defaultReplyTo('telegram:triage/1')
    const first = start()
    await until(() => savedState().cursors[ws])
    await first.stop()

    reply = async () => answers('done while you were away')
    send(ws, 'from a terminal', { env })
    await idle(1)

    start()
    await until(() => said(1).some(s => s.text === 'sent from elsewhere\n\ndone while you were away'))
  })
})

describe('commands', () => {
  it('say what the spore is doing, and stop only what is running', async () => {
    start()
    tg.push(message(1, 1, '/status'))
    tg.push(message(2, 1, '/stop'))
    tg.push(message(3, 1, '/start'))
    await until(() => said(1).length === 3)
    expect(said(1)[0].text).toMatch(/^spore · anthropic\/claude-haiku-4-5\nidle · 0 turns · \$0\.0000/)
    expect(said(1)[1].text).toBe('nothing is running')
    expect(said(1)[2].text).toMatch(/\/status/)
    expect(readInbox(ws)).toEqual([])
  })

  it('change the running turn\'s limits, and say why when nothing changes', async () => {
    start()
    tg.push(message(1, 1, '/wrap'))
    tg.push(message(2, 1, '/extend wall 30m'))
    tg.push(message(3, 1, '/extend'))
    tg.push(message(4, 1, '/extend time 1h'))
    await until(() => said(1).length === 4)
    expect(said(1).map(s => s.text)).toEqual([
      'nothing is running',
      'nothing is running',
      '/extend wall 30m, /extend cost 1.50 or /extend rounds 20',
      'a turn\'s limits are rounds, cost, wall, not "time" — as spore extend <name> wall 30m'
    ])
    expect(readInbox(ws)).toEqual([])
  })
})
