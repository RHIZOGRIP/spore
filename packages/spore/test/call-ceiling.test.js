/**
 * The host's call ceiling, from its config file through `spore send` to the runner: a model call
 * still running past it is aborted at the gate that streams it, and the turn's record says so.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startGate } from './fixtures/model-server.js'
import { scriptedMo } from './fixtures/scripted-model.js'
import { outsideRoot, outsideWorkspace } from './fixtures/outside-ws.js'
import { readInbox, readTurns } from '../src/core/spore-dir.js'

const run = promisify(execFile)
const SPORE = resolve(dirname(fileURLToPath(import.meta.url)), '../../spore-cli/bin/spore.js')

let ws
let home
let gate

const spore = (prompt) => run(process.execPath, [SPORE, 'send', ws, prompt], {
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_CONFIG_HOME: home
  }
}).catch(err => err)

beforeEach(async () => {
  ws = outsideWorkspace('call-ceiling')
  home = outsideRoot('call-ceiling-config')
  gate = await startGate({ mo: scriptedMo(() => new Promise(() => {})), name: 'call-ceiling' })
  gate.configure({ callCeiling: '1s' }, resolve(home, 'spore', 'config.json'))
})

afterEach(async () => {
  await gate.close()
  rmSync(ws, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

describe('a model call past the host\'s ceiling', () => {
  it('is aborted at the gate, and the turn ends on it with the cut written down', async () => {
    const started = Date.now()
    const result = await spore('hello')
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(result.code).not.toBe(0)

    expect(gate.aborts).toEqual([{ callId: gate.envelopes[0].callId, authId: 'tests', gate: 'scripted' }])
    expect(readTurns(ws).at(-1)).toMatchObject({ stopReason: 'error', cut: 1 })
    expect(readInbox(ws).map(entry => entry.text)).toEqual(['hello'])
  })
})
