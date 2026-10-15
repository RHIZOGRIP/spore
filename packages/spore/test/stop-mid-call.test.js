import './fixtures/own-config.js'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { createModelServer } from './fixtures/model-server.js'
import { brokerSocketPath } from '../src/infra/broker-socket.js'
import { outsideWorkspace } from './fixtures/outside-ws.js'
import { outbox, readInbox, readTurns, statePath } from '../src/core/spore-dir.js'
import { send } from '../src/core/send.js'
import { RUNNING, stateOf, stop } from '../src/core/state.js'
import { CONFIG_FILE } from '../src/library/config.js'

let ws
let broker
let asked
let release

const env = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, SPORE_MODEL_SOCKET: broker.socketPath })

const held = () => ({
  use: (modelId) => ({
    id: modelId,
    info: () => ({ contextTokenLimit: 200000 }),
    answer: async () => {
      asked += 1
      await new Promise(resolve => { release = resolve })
      return { status: 'completed', output: 'late', cost: 0.01 }
    }
  })
})

const tail = (file) => (existsSync(join(ws, file)) ? readFileSync(join(ws, file), 'utf8').slice(-1500) : null)

const shown = () => {
  const db = new DatabaseSync(statePath(ws), { readOnly: true })
  try {
    return JSON.stringify({
      rows: db.prepare('SELECT state, stopReason, inboxTo, error, detail FROM t_turns ORDER BY rowid').all(),
      consumed: db.prepare('SELECT inboxConsumed FROM t_workspace').get(),
      state: stateOf(ws).state,
      err: tail('spore.err'),
      out: tail('spore.out')
    })
  } finally {
    db.close()
  }
}

const until = async (done, limitMs = 15000) => {
  const deadline = Date.now() + limitMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`waited too long — ${shown()}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const unread = () => readInbox(ws, { after: readTurns(ws).at(-1)?.inboxTo ?? 0 }).map(entry => entry.text)

beforeEach(async () => {
  asked = 0
  release = null
  ws = outsideWorkspace('stop-mid-call')
  broker = createModelServer({ mo: held(), socketPath: brokerSocketPath('stop-mid-call'), limit: 10 })
  await broker.listen()
})

afterEach(async () => {
  release?.()
  if (stateOf(ws).state === RUNNING) stop(ws)
  await until(() => stateOf(ws).state !== RUNNING, 20_000)
  await broker.close()
  rmSync(ws, { recursive: true, force: true })
})

describe.each([true, false])('a turn stopped while its model call is still open, contained: %s', (contain) => {
  beforeEach(() => {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify({ contain }))
  })

  const relayed = (n) => ({ replyTo: 'telegram:triage/1', from: { name: 'U1 (@u1)', id: 'telegram:1', where: 'a private chat on Telegram' }, requestId: `telegram:triage:${n}` })

  const stopped = async (releasing, { said = () => ({}), endings = ['cancelled'] } = {}) => {
    expect(send(ws, 'first', { env: env(), ...said(1) }).started).toBe(true)
    await until(() => asked === 1)
    expect(send(ws, 'second', { env: env(), ...said(2) }).started).toBe(false)
    expect(stop(ws).stopped).toBe(true)
    await releasing()
    await until(() => readTurns(ws).length === 1 && stateOf(ws).state !== RUNNING)
    const [turn] = readTurns(ws)
    expect(endings, shown()).toContain(turn.stopReason)
    expect(turn.inboxTo).toBe(1)
    expect(unread()).toEqual(['second'])
  }

  it('is written down as cancelled, having read what it read, when the call ends after the stop', async () => {
    await stopped(() => new Promise(resolve => setTimeout(() => { release(); resolve() }, 300)))
  })

  it('is written down, having read what it read, when the call ends as it is stopped — cancelled or answered, whichever came first', async () => {
    await stopped(async () => release(), { endings: ['cancelled', 'answer'] })
  })

  it('is written down so for a relay, its answer addressed to where it was asked from', async () => {
    await stopped(() => new Promise(resolve => setTimeout(() => { release(); resolve() }, 300)), { said: relayed })
    expect(outbox(ws).map(entry => [entry.recipient, entry.answers])).toEqual([['telegram:triage/1', [1]]])
  })

  it('is written down so for a relay when the call ends as it is stopped', async () => {
    await stopped(async () => release(), { said: relayed, endings: ['cancelled', 'answer'] })
  })

  it('is written down as cancelled, never left as a crash, when the stop lands as its runner starts', async () => {
    expect(send(ws, 'first', { env: env() }).started).toBe(true)
    const deadline = Date.now() + 15000
    while (stateOf(ws).state !== RUNNING) {
      if (Date.now() > deadline) throw new Error(`never running — ${shown()}`)
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(stop(ws).stopped).toBe(true)
    release?.()
    await until(() => readTurns(ws).length === 1 && stateOf(ws).state !== RUNNING)
    expect([stateOf(ws).state, readTurns(ws)[0].stopReason], shown()).toEqual(['cancelled', 'cancelled'])
  })
})
