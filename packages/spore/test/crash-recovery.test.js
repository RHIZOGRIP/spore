import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

import { createModelServer } from './fixtures/model-server.js'
import { brokerSocketPath } from '../src/infra/broker-socket.js'
import { outsideWorkspace } from './fixtures/outside-ws.js'
import { readEvents, readPending, readTurns } from '../src/core/spore-dir.js'
import { send } from '../src/core/send.js'
import { RUNNING, stateOf } from '../src/core/state.js'

let ws
let broker
let asked

const env = (crashAt) => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  SPORE_MODEL_SOCKET: broker.socketPath,
  ...(crashAt ? { SPORE_CRASH_AT: crashAt } : {})
})

const until = async (done, limitMs = 15000) => {
  const deadline = Date.now() + limitMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('waited too long')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const ends = () => readEvents(ws, { event: 'turn_end' }).map(e => e.turnNo)
const said = () => existsSync(resolve(ws, 'spore.err')) ? readFileSync(resolve(ws, 'spore.err'), 'utf8') : 'no spore.err'

beforeEach(async () => {
  asked = 0
  ws = outsideWorkspace('crash-recovery')
  const mo = {
    use: (modelId) => ({
      id: modelId,
      info: () => ({ contextTokenLimit: 200000 }),
      answer: async () => ({ status: 'completed', output: `answer ${++asked}`, cost: 0.01 })
    })
  }
  broker = createModelServer({ mo, socketPath: brokerSocketPath('crash-recovery'), limit: 10 })
  await broker.listen()
})

afterEach(async () => {
  await broker.close()
  rmSync(ws, { recursive: true, force: true })
})

describe('a runner that dies', () => {
  it('before writing the turn down leaves it pending, and the next runner writes it once, unsettled', async () => {
    send(ws, 'one', { env: env('before-finalize') })
    await until(() => stateOf(ws).state === 'crashed')
    expect(readTurns(ws), said()).toEqual([])
    expect(readPending(ws), said()).toMatchObject({ stopReason: 'answer', concluded: true, inboxTo: 1 })
    expect(ends()).toEqual([])

    send(ws, 'two', { env: env() })
    await until(() => readTurns(ws).length === 2 && stateOf(ws).state !== RUNNING)
    const [first, second] = readTurns(ws)
    expect(first).toMatchObject({ turnNo: 1, stopReason: 'answer', concluded: true, settled: false, inboxFrom: 0, inboxTo: 1 })
    expect(second).toMatchObject({ turnNo: 2, stopReason: 'answer', inboxFrom: 1, inboxTo: 2 })
    expect(readPending(ws)).toBe(null)
    expect(ends()).toEqual([1, 2])
    expect(asked).toBe(2)
  })

  it('after writing the turn down leaves nothing to redo', async () => {
    send(ws, 'one', { env: env('after-finalize') })
    await until(() => stateOf(ws).state === 'crashed')
    expect(readTurns(ws).map(t => t.turnNo), said()).toEqual([1])
    expect(ends(), said()).toEqual([1])

    send(ws, 'two', { env: env() })
    await until(() => readTurns(ws).length === 2 && stateOf(ws).state !== RUNNING)
    expect(readTurns(ws).map(t => [t.turnNo, t.inboxFrom, t.inboxTo])).toEqual([[1, 0, 1], [2, 1, 2]])
    expect(ends()).toEqual([1, 2])
    expect(asked).toBe(2)
  })
})

describe('an outcome whose answer is lost', () => {
  it('is written down once, as the agent told it, however the agent fared after', async () => {
    send(ws, 'one', { env: env('outcome-unanswered') })
    await until(() => readTurns(ws).length === 1 && stateOf(ws).state !== RUNNING)
    const [turn] = readTurns(ws)
    expect(turn).toMatchObject({ turnNo: 1, stopReason: 'answer', concluded: true, inboxTo: 1 })
    expect(ends()).toEqual([1])
    expect(readPending(ws)).toBe(null)
  })
})
