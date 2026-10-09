import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'

import { createModelServer } from './fixtures/model-server.js'
import { outsideWorkspace } from './fixtures/outside-ws.js'
import { brokerSocketPath } from '../src/infra/broker-socket.js'
import { readInbox, readLock, readTurns } from '../src/core/spore-dir.js'
import { send } from '../src/core/send.js'
import { RUNNING, stateOf } from '../src/core/state.js'

const T1 = '00-11111111111111111111111111111111-1111111111111111-01'
const T2 = '00-22222222222222222222222222222222-2222222222222222-01'

let ws
let broker
let waiting

const env = (extra = {}) => ({ PATH: process.env.PATH, HOME: process.env.HOME, SPORE_MODEL_SOCKET: broker.socketPath, ...extra })

// Every model call waits until the test lets it answer, so the agent is alive to be looked at.
const held = () => ({
  use: (modelId) => ({
    id: modelId,
    info: () => ({ contextTokenLimit: 200000 }),
    answer: () => new Promise(resolve => waiting.push(() => resolve({ status: 'completed', output: 'ok', cost: 0.01 })))
  })
})

const until = async (done, limitMs = 15000) => {
  const deadline = Date.now() + limitMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('waited too long')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

// The trace context the running turn gave its agent, read from the agent's own environment.
const agentTrace = () => {
  const runner = readLock(ws).pid
  const children = readFileSync(`/proc/${runner}/task/${runner}/children`, 'utf8').trim().split(/\s+/)
  const agent = children.find(pid => readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('spore-agent.js'))
  const entry = readFileSync(`/proc/${agent}/environ`, 'utf8').split('\0').find(line => line.startsWith('TRACEPARENT='))
  return entry ? entry.slice('TRACEPARENT='.length) : null
}

const answerCall = async (n) => {
  await until(() => waiting.length >= n)
  waiting[n - 1]()
}

const idle = () => until(() => stateOf(ws).state !== RUNNING)

beforeEach(async () => {
  waiting = []
  ws = outsideWorkspace('trace-turns')
  broker = createModelServer({ mo: held(), socketPath: brokerSocketPath('trace'), limit: 10 })
  await broker.listen()
})

afterEach(async () => {
  for (const release of waiting) release()
  await idle().catch(() => {})
  await broker?.close()
  rmSync(ws, { recursive: true, force: true })
})

describe('a turn\'s trace', () => {
  it('is the trace of the message that started it', async () => {
    const sent = send(ws, 'summarise the tickets', { traceparent: T1, env: env() })
    expect(readInbox(ws).map(entry => entry.inboxNo)).toEqual([sent.inbox])
    await until(() => waiting.length === 1)
    expect(agentTrace()).toBe(T1)
    await answerCall(1)
    await idle()
  })

  it('is none of the runner\'s own when no message carries one', async () => {
    send(ws, 'summarise the tickets', { env: env({ TRACEPARENT: T2 }) })
    await until(() => waiting.length === 1)
    expect(agentTrace()).toBe(null)
    await answerCall(1)
    await idle()
  })

  it('is, for a turn carried on, the first of its own messages that carries one', async () => {
    send(ws, 'summarise the tickets', { traceparent: T1, env: env() })
    await until(() => waiting.length === 1)

    // Both land while turn 1 is in its last call, so turn 2 answers them together.
    send(ws, 'and flag anything about billing', { env: env() })
    send(ws, 'include last week too', { traceparent: T2, env: env() })
    await answerCall(1)

    await until(() => waiting.length === 2)
    expect(agentTrace()).toBe(T2)
    await answerCall(2)
    await idle()
    expect(readTurns(ws)).toHaveLength(2)
  })
})
