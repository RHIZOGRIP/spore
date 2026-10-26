import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { startGate } from './fixtures/model-server.js'
import { outsideWorkspace } from './fixtures/outside-ws.js'
import { readTurns } from '../src/core/spore-dir.js'
import { flush } from '../src/library/verbs.js'
import { send } from '../src/core/send.js'
import { RUNNING, stateOf } from '../src/core/state.js'

let ws
let gate
let seen
let inputs

const until = async (done, limitMs = 15000) => {
  const deadline = Date.now() + limitMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('waited too long')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

beforeEach(async () => {
  seen = []
  inputs = []
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
        inputs.push(input)
        return { status: 'completed', output: 'answered', cost: 0.01 }
      }
    })
  }
  gate = await startGate({ mo, name: 'recall-send' })
})

afterEach(async () => {
  await gate.close()
  rmSync(ws, { recursive: true, force: true })
})

describe('recall on a turn started by send', () => {
  it('surfaces what the message brings to mind, as a turn given its prompt directly does', async () => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME }
    send(ws, 'Which camera accessories would suit my Sony?', { env })
    await until(() => readTurns(ws).length === 1 && stateOf(ws).state !== RUNNING)

    const [turn] = readTurns(ws)
    expect(turn.concluded).toBe(true)
    expect(turn.recall?.length).toBeGreaterThan(0)
    expect(seen[0]).toMatch(/Recalled/)
    expect(seen[0]).toMatch(/Sony A7R IV/)
  })
})

describe('a turn after a flush', () => {
  it('sees none of what was said before, and recall still reaches it', async () => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME }
    send(ws, 'My locker code is 4417.', { env })
    await until(() => readTurns(ws).length === 1 && stateOf(ws).state !== RUNNING)
    flush({ ws, by: 'its operator' })
    send(ws, 'What is my locker code?', { env })
    await until(() => readTurns(ws).length === 2 && stateOf(ws).state !== RUNNING)

    const after = inputs.at(-1).filter(m => m.role !== 'system').map(m => JSON.stringify(m.content))
    expect(after[0]).toMatch(/The conversation was flushed/)
    expect(after.filter(text => text.includes('4417'))).toEqual([expect.stringMatching(/Recalled[\s\S]*4417[\s\S]*What is my locker code\?/)])
    expect(after.some(text => text.includes('answered'))).toBe(false)
  })
})
