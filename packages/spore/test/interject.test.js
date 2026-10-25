import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import { promisify } from 'node:util'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startGate } from './fixtures/model-server.js'
import { outsideWorkspace } from './fixtures/outside-ws.js'
import { readSaidSoFar, readTurns } from '../src/core/spore-dir.js'
import { show } from '../src/library/verbs.js'

const run = promisify(execFile)
const SPORE = resolve(dirname(fileURLToPath(import.meta.url)), '../../spore-cli/bin/spore.js')

let ws
let gate
let seen

const spore = (args) => run(process.execPath, [SPORE, ...args], {
  env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
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
  gate = await startGate({ mo: scripted(5), name: 'interject' })
})

afterEach(async () => {
  await gate.close()
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

  it('is waiting until the running turn reads it, and the message it is answering is not', async () => {
    const turn = spore(['send', ws, 'a long job'])
    await until(() => seen.length === 1)
    expect(show({ ws }).waiting).toBe(0)

    await spore(['send', ws, 'skip the appendices'])
    await until(() => seen.some(round => round.includes('skip the appendices')))
    expect(show({ ws }).waiting).toBe(0)
    await turn
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
