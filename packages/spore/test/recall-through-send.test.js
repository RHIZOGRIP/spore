import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createModelServer } from './fixtures/model-server.js'
import { brokerSocketPath } from '../src/infra/broker-socket.js'
import { outsideWorkspace } from './fixtures/outside-ws.js'
import { readTurns } from '../src/core/spore-dir.js'
import { send } from '../src/core/send.js'
import { RUNNING, stateOf } from '../src/core/state.js'

let ws
let broker
let seen

const until = async (done, limitMs = 15000) => {
  const deadline = Date.now() + limitMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('waited too long')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

beforeEach(async () => {
  seen = []
  ws = outsideWorkspace('recall-send')
  const path = resolve(ws, 'spore.cmk')
  writeFileSync(path, readFileSync(path, 'utf8').replace(/^memory: .*\npush: .*\npull: .*\n/m, 'memory: bm25\npush: 3\npull: 5\n'))
  mkdirSync(resolve(ws, 'data/memory'), { recursive: true })
  writeFileSync(resolve(ws, 'data/memory/person.md'), '# Gear\nOwns a Sony A7R IV and wants camera accessories.\n')
  const mo = {
    use: (modelId) => ({
      id: modelId,
      info: () => ({ contextTokenLimit: 200000 }),
      answer: async (input) => {
        seen.push(input.filter(m => m.role === 'user').map(m => JSON.stringify(m.content)).join(' | '))
        return { status: 'completed', output: 'answered', cost: 0.01 }
      }
    })
  }
  broker = createModelServer({ mo, socketPath: brokerSocketPath('recall-send'), limit: 10 })
  await broker.listen()
})

afterEach(async () => {
  await broker.close()
  rmSync(ws, { recursive: true, force: true })
})

describe('recall on a turn started by send', () => {
  it('surfaces what the message brings to mind, as a turn given its prompt directly does', async () => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, SPORE_MODEL_SOCKET: broker.socketPath }
    send(ws, 'Which camera accessories would suit my Sony?', { env })
    await until(() => readTurns(ws).length === 1 && stateOf(ws).state !== RUNNING)

    const [turn] = readTurns(ws)
    expect(turn.concluded).toBe(true)
    expect(turn.recall?.length).toBeGreaterThan(0)
    expect(seen[0]).toMatch(/Recalled/)
    expect(seen[0]).toMatch(/Sony A7R IV/)
  })
})
