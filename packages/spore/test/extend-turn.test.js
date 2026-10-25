import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { startGate } from './fixtures/model-server.js'
import { outsideWorkspace, withAuth } from './fixtures/outside-ws.js'
import { definitionWith } from '../src/testing.js'
import { readTurns, runningLimits } from '../src/core/spore-dir.js'
import { send } from '../src/core/send.js'
import { RUNNING, stateOf } from '../src/core/state.js'
import { changeText, extendTurn } from '../src/core/limits.js'

let ws
let gate

const until = async (done, limitMs = 20000) => {
  const deadline = Date.now() + limitMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('waited too long')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const slow = () => {
  let calls = 0
  return {
    use: (modelId) => ({
      id: modelId,
      info: () => ({ contextTokenLimit: 200000 }),
      answer: async () => (++calls === 1
        ? { status: 'tool_use', output: '', toolCalls: [{ id: 'c1', name: 'wsexec', arguments: { command: 'for i in 1 2 3 4 5 6; do echo $i; sleep 1; done', out: 'data/count.log', timeout: 30 } }], cost: 0.01 }
        : { status: 'completed', output: 'counted', cost: 0.01 })
    })
  }
}

beforeEach(async () => {
  ws = outsideWorkspace('extend-turn')
  writeFileSync(resolve(ws, 'spore.cmk'), withAuth(definitionWith('anthropic/claude-haiku-4-5')).replace(/^wall: .*$/m, 'wall: [1s, 4s]\nextend.wall: 1m'))
  gate = await startGate({ mo: slow(), name: 'extend-turn' })
})

afterEach(async () => {
  await gate.close()
  rmSync(ws, { recursive: true, force: true })
})

describe('a turn whose owner raises its wall', () => {
  it('runs past the wall it started with, and ends on its own terms', { timeout: 40000 }, async () => {
    send(ws, 'count to six', { env: { PATH: process.env.PATH, HOME: process.env.HOME } })
    await until(() => runningLimits(ws) !== null)
    expect(changeText(extendTurn(ws, 'wall', '30s'))).toBe('its wall now wraps at 31s and stops at 34s')
    await until(() => stateOf(ws).state !== RUNNING && readTurns(ws).length === 1)

    const [turn] = readTurns(ws)
    expect(turn).toMatchObject({ stopReason: 'answer', output: 'counted' })
  })
})
