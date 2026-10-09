import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import { promisify } from 'node:util'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createModelServer } from './fixtures/model-server.js'
import { brokerSocketPath } from '../src/infra/broker-socket.js'
import { outsideWorkspace } from './fixtures/outside-ws.js'
import { readSaidSoFar, readTurns } from '../src/core/spore-dir.js'

const run = promisify(execFile)
const SPORE = resolve(dirname(fileURLToPath(import.meta.url)), '../../spore-cli/bin/spore.js')

let ws
let broker
let seen

const spore = (args) => run(process.execPath, [SPORE, ...args], {
  env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, SPORE_MODEL_SOCKET: broker.socketPath }
})

// Slow enough that a message sent from the test lands between two of its rounds, which
// is the only moment the loop reads the inbox.
const until = async (done, limitMs = 15000) => {
  const deadline = Date.now() + limitMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('waited too long')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const scripted = (rounds) => ({
  use: (modelId) => ({
    id: modelId,
    info: () => ({ contextTokenLimit: 200000 }),
    answer: async (input) => {
      seen.push(input.filter(m => m.role === 'user').map(m => JSON.stringify(m.content)).join(' | '))
      if (seen.length >= rounds) return { status: 'completed', output: 'done', cost: 0.01 }
      await new Promise(resolve => setTimeout(resolve, 500))
      return {
        status: 'tool_use',
        output: '',
        toolCalls: [{ id: `c${seen.length}`, name: 'wsexec', arguments: { command: 'true', out: `data/r${seen.length}.txt` } }],
        cost: 0.01
      }
    }
  })
})

beforeEach(async () => {
  seen = []
  ws = outsideWorkspace('interject')
  broker = createModelServer({ mo: scripted(5), socketPath: brokerSocketPath('interject'), limit: 10 })
  await broker.listen()
})

afterEach(async () => {
  await broker.close()
  rmSync(ws, { recursive: true, force: true })
})

describe('a message sent to a turn already running', () => {
  it('reaches the model between rounds, and is written down as the person speaking', async () => {
    const turn = spore(['send', ws, 'a long job'])
    await until(() => seen.length === 1)

    await spore(['send', ws, 'skip the appendices'])
    await turn

    expect(seen.some(round => round.includes('skip the appendices'))).toBe(true)
    // Not every round: it arrived partway through, and the rounds before it never saw it.
    expect(seen[0]).not.toContain('skip the appendices')

    const said = readSaidSoFar(ws)
      .filter(m => m.role === 'user').map(m => m.content)
    expect(said).toContain('a long job')
    expect(said).toContain('skip the appendices')
  })

  it('does not start a second turn, because the lock says one is already running', async () => {
    const turn = spore(['send', ws, 'a long job'])
    await until(() => seen.length === 1)

    await spore(['send', ws, 'and this too'])
    await turn

    // One runner, so one turn record — the second message joined the first turn.
    expect(readTurns(ws)).toHaveLength(1)
  })
})
