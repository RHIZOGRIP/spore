/**
 * A refusal that names how long to wait, from the gate through `spore send` to the turn record:
 * the turn waits when the wait ends before its hard wall, and ends on the refusal when it does not.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startGate } from './fixtures/model-server.js'
import { answers, scriptedMo } from './fixtures/scripted-model.js'
import { outsideRoot, outsideWorkspace } from './fixtures/outside-ws.js'
import { readTurns } from '../src/core/spore-dir.js'

const run = promisify(execFile)
const SPORE = resolve(dirname(fileURLToPath(import.meta.url)), '../../spore-cli/bin/spore.js')

let ws
let home
let gate

const refusal = (retryAfterMs) => Object.assign(new Error('rate limited'), {
  type: 'RATE_LIMIT_TIER',
  detail: 'Rate limit exceeded: free-models-per-min.',
  retryable: true,
  retryAfterMs
})

const start = async (name, wall, reply) => {
  ws = outsideWorkspace(name)
  const cmk = resolve(ws, 'spore.cmk')
  writeFileSync(cmk, readFileSync(cmk, 'utf8').replace(/^wall: .*$/m, `wall: ${wall}`))
  home = outsideRoot(`${name}-config`)
  gate = await startGate({ mo: scriptedMo(reply), name })
  gate.configure({}, resolve(home, 'spore', 'config.json'))
}

const spore = (prompt) => run(process.execPath, [SPORE, 'send', ws, prompt], {
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_CONFIG_HOME: home
  }
}).catch(err => err)

afterEach(async () => {
  await gate.close()
  rmSync(ws, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

describe('a refusal that names its wait', () => {
  it('is waited out when the wait ends before the hard wall, and the turn answers', { timeout: 30_000 }, async () => {
    await start('named-wait-short', '[20s, 25s]', (input, i) => {
      if (i === 0) throw refusal(1_000)
      return answers('after the wait')
    })
    await spore('hello')
    expect(readTurns(ws).at(-1)).toMatchObject({ stopReason: 'answer', output: 'after the wait' })
  })

  it('ends the turn on the refusal when the wait reaches the hard wall, rather than at the wall', { timeout: 30_000 }, async () => {
    await start('named-wait-long', '[3s, 6s]', () => { throw refusal(60_000) })
    const started = Date.now()
    await spore('hello')
    expect(Date.now() - started).toBeLessThan(6_000)
    expect(readTurns(ws).at(-1)).toMatchObject({ stopReason: 'error', error: 'RATE_LIMIT_TIER' })
    expect(gate.envelopes).toHaveLength(1)
  })
})
