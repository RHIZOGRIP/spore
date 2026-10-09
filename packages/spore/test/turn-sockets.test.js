import './fixtures/own-config.js'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createModelServer } from './fixtures/model-server.js'
import { brokerSocketPath } from '../src/infra/broker-socket.js'
import { outsideWorkspace } from './fixtures/outside-ws.js'
import { definitionPath, readTurns } from '../src/core/spore-dir.js'
import { CONFIG_DIR } from '../src/library/config.js'
import { send } from '../src/core/send.js'
import { RUNNING, stateOf } from '../src/core/state.js'

let ws
let broker
let round

const until = async (done, limitMs = 15000) => {
  const deadline = Date.now() + limitMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('waited too long')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

// Each turn writes its environment on its first round; the first turn's last round is slow,
// so a second message lands while it runs and the same runner carries on to a second turn.
const scripted = {
  use: (modelId) => ({
    id: modelId,
    info: () => ({ contextTokenLimit: 200000 }),
    answer: async () => {
      round++
      if (round === 1 || round === 3) {
        return { status: 'tool_use', output: '', toolCalls: [{ id: `c${round}`, name: 'wsexec', arguments: { command: 'env', out: `data/env${round}.txt` } }], cost: 0.01 }
      }
      if (round === 2) await new Promise(resolve => setTimeout(resolve, 800))
      return { status: 'completed', output: `answer ${round}`, cost: 0.01 }
    }
  })
}

const socketIn = (file) => readFileSync(resolve(ws, 'data', file), 'utf8').split('\n')
  .find(line => line.startsWith('SPORE_SOURCE_SOCKET='))?.split('=')[1]

beforeEach(async () => {
  round = 0
  ws = outsideWorkspace('turn-sockets')
  writeFileSync(definitionPath(ws), readFileSync(definitionPath(ws), 'utf8').replace('\n---', '\nsources: [ledger]\n---'))
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(resolve(CONFIG_DIR, 'sources.json'), JSON.stringify({ ledger: { url: 'http://ledger.invalid' } }))
  broker = createModelServer({ mo: scripted, socketPath: brokerSocketPath('turn-sockets'), limit: 10 })
  await broker.listen()
})

afterEach(async () => {
  await broker.close()
  rmSync(ws, { recursive: true, force: true })
})

describe('the sockets a runner serves', () => {
  it('belong to a turn: the next turn of the same runner is served on new ones, and the last are gone', async () => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, SPORE_MODEL_SOCKET: broker.socketPath }
    expect(send(ws, 'first', { env }).started).toBe(true)
    await until(() => round === 2)
    expect(send(ws, 'second', { env }).started).toBe(false)
    await until(() => readTurns(ws).length === 2 && stateOf(ws).state !== RUNNING)

    const first = socketIn('env1.txt')
    const second = socketIn('env3.txt')
    expect(first).toBeTruthy()
    expect(second).toBeTruthy()
    expect(second).not.toBe(first)
    expect(existsSync(first)).toBe(false)
    expect(existsSync(second)).toBe(false)
  })
})
