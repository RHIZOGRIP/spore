import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { startGate } from './fixtures/model-server.js'
import { outsideWorkspace } from './fixtures/outside-ws.js'
import { readInbox, readLock, readSaidSoFar, readTurns } from '../src/core/spore-dir.js'
import { send } from '../src/core/send.js'
import { runBatch } from '../src/core/batch.js'
import { RUNNING, stateOf } from '../src/core/state.js'

let ws
let gate
let seen
let reply

const env = () => ({ PATH: process.env.PATH, HOME: process.env.HOME })

const until = async (done, limitMs = 15000) => {
  const deadline = Date.now() + limitMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('waited too long')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const unread = () => {
  const read = readTurns(ws).at(-1)?.inboxTo ?? 0
  return readInbox(ws, { after: read }).map(entry => entry.text)
}

const withVectorMemory = () => {
  const path = resolve(ws, 'spore.cmk')
  writeFileSync(path, readFileSync(path, 'utf8').replace(/^memory: .*\npush: .*\npull: .*\n/m, 'memory: vectors\npush: 5\npull: 20\nembedding: e/small\n'))
}

beforeEach(async () => {
  seen = []
  reply = async () => ({ status: 'completed', output: `answer ${seen.length}`, cost: 0.01 })
  ws = outsideWorkspace('turn-records')
  const mo = {
    use: (modelId) => ({
      id: modelId,
      info: () => ({ contextTokenLimit: 200000 }),
      answer: async (input) => {
        seen.push(input.filter(m => m.role === 'user').map(m => JSON.stringify(m.content)).join(' | '))
        return reply()
      }
    })
  }
  gate = await startGate({ mo, name: 'turn-records' })
})

afterEach(async () => {
  await gate.close()
  rmSync(ws, { recursive: true, force: true })
})

describe('a turn the agent never recorded', () => {
  it('is recorded by the runner when it refuses to start, and the message stays pending', async () => {
    withVectorMemory()

    expect(send(ws, 'remember this', { env: env() }).started).toBe(true)
    await until(() => readTurns(ws).length === 1)
    await until(() => stateOf(ws).state !== RUNNING)

    const [turn] = readTurns(ws)
    expect(turn.stopReason).toBe('error')
    expect(turn.error).toBe('START_FAILED')
    expect(turn.detail).toMatch(/keeps its memory in a vector store, and there is no .*memory\.json/)
    expect(turn.concluded).toBe(false)
    expect(stateOf(ws).state).toBe('failed')
    expect(unread()).toEqual(['remember this'])
    expect(seen).toEqual([])
  })

  it('is recorded by the runner when the agent dies without a record', async () => {
    let release
    reply = () => new Promise(resolve => { release = () => resolve({ status: 'completed', output: 'late', cost: 0.01 }) })
    send(ws, 'first', { env: env() })
    await until(() => seen.length === 1)

    const runner = readLock(ws).pid
    const agent = Number(readFileSync(`/proc/${runner}/task/${runner}/children`, 'utf8').trim().split(/\s+/)[0])
    process.kill(agent, 'SIGKILL')
    // The runner reads the call the agent died during to its end before it writes the turn down.
    release()
    await until(() => stateOf(ws).state !== RUNNING)

    const [turn] = readTurns(ws)
    expect(turn.stopReason).toBe('error')
    expect(turn.error).toBe('AGENT_EXITED')
    expect(turn.detail).toMatch(/SIGKILL|signal: 9/)
    expect(unread()).toEqual(['first'])
  })

  it('finishes a batch whose run refused to start, rather than waiting on it', async () => {
    withVectorMemory()

    const outcome = await runBatch([{ ws, messages: ['one'], label: 'refused', id: 'refused' }], { env: env(), pollMs: 50, deadline: Date.now() + 15000 })

    expect(outcome.stuck).toEqual([])
    expect(readTurns(ws).at(-1).error).toBe('START_FAILED')
  })
})

describe('a turn that died of an error', () => {
  it('leaves its message pending without the next turn reading answered ones again', async () => {
    send(ws, 'first', { env: env() })
    await until(() => readTurns(ws).length === 1 && stateOf(ws).state !== RUNNING)

    reply = async () => { throw Object.assign(new Error('refused'), { type: 'AUTH_UNAVAILABLE', detail: 'no key for the provider' }) }
    send(ws, 'second', { env: env() })
    await until(() => readTurns(ws).length === 2 && stateOf(ws).state !== RUNNING)
    expect(readTurns(ws)[1].stopReason).toBe('error')
    expect(unread()).toEqual(['second'])

    reply = async () => ({ status: 'completed', output: 'third answered', cost: 0.01 })
    send(ws, 'third', { env: env() })
    await until(() => readTurns(ws).length === 3 && stateOf(ws).state !== RUNNING)

    const said = readSaidSoFar(ws).filter(m => m.role === 'user').map(m => m.content)
    expect(said.filter(text => text === 'first')).toHaveLength(1)
    expect(seen.at(-1)).toContain('third')
    expect(unread()).toEqual([])
  })
})
