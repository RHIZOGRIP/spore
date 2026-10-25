import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'

import { startGate } from './fixtures/model-server.js'
import { outsideWorkspace } from './fixtures/outside-ws.js'
import { readInbox, readTurns } from '../src/core/spore-dir.js'
import { send } from '../src/core/send.js'
import { RUNNING, stateOf, stop } from '../src/core/state.js'

let ws
let gate
let seen

const env = () => ({ PATH: process.env.PATH, HOME: process.env.HOME })

// The first call is slow, so a message sent while it runs lands after the loop last read the
// inbox: the turn answers without it, and nothing in the turn will look again.
const slowFirst = (firstMs) => ({
  use: (modelId) => ({
    id: modelId,
    info: () => ({ contextTokenLimit: 200000 }),
    answer: async (input) => {
      seen.push(input.filter(m => m.role === 'user').map(m => JSON.stringify(m.content)).join(' | '))
      if (seen.length === 1) await new Promise(resolve => setTimeout(resolve, firstMs))
      return { status: 'completed', output: `answer ${seen.length}`, cost: 0.01 }
    }
  })
})

const until = async (done, limitMs = 15000) => {
  const deadline = Date.now() + limitMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('waited too long')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const idle = () => until(() => stateOf(ws).state !== RUNNING)

const unread = () => {
  const read = readTurns(ws).at(-1)?.inboxTo ?? 0
  return readInbox(ws, { after: read }).map(entry => entry.text)
}

const start = async (firstMs) => {
  gate = await startGate({ mo: slowFirst(firstMs), name: 'stranded' })
}

beforeEach(() => {
  seen = []
  ws = outsideWorkspace('stranded-inbox')
})

afterEach(async () => {
  await gate?.close()
  gate = null
  rmSync(ws, { recursive: true, force: true })
})

describe('a message that lands during the final model call', () => {
  it('is answered by another turn of the same runner', async () => {
    await start(800)
    expect(send(ws, 'first', { env: env() }).started).toBe(true)
    await until(() => seen.length === 1)

    expect(send(ws, 'second', { env: env() }).started).toBe(false)
    await idle()

    const turns = readTurns(ws)
    expect(turns).toHaveLength(2)
    expect(turns.every(turn => turn.concluded)).toBe(true)
    expect(seen[0]).not.toContain('second')
    expect(seen[1]).toContain('second')
    expect(unread()).toEqual([])
    expect(stateOf(ws).state).toBe('idle')
  })

  it('is left for the next send when the turn was stopped', async () => {
    await start(5000)
    send(ws, 'first', { env: env() })
    await until(() => seen.length === 1)

    expect(send(ws, 'second', { env: env() }).started).toBe(false)
    expect(stop(ws).stopped).toBe(true)
    await idle()

    const turns = readTurns(ws)
    expect(turns).toHaveLength(1)
    expect(turns[0].stopReason).toBe('cancelled')
    expect(unread()).toEqual(['second'])
    expect(seen).toHaveLength(1)
  })
})
