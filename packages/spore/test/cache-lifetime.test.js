/**
 * The root's prompt-cache lifetime, from `cache:` in its spore.cmk to the breakpoint its system
 * prompt carries in every call the gate sees.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startGate } from './fixtures/model-server.js'
import { answers, scriptedMo } from './fixtures/scripted-model.js'
import { outsideWorkspace } from './fixtures/outside-ws.js'

const run = promisify(execFile)
const SPORE = resolve(dirname(fileURLToPath(import.meta.url)), '../../spore-cli/bin/spore.js')

let ws
let gate

const spore = (prompt) => run(process.execPath, [SPORE, 'send', ws, prompt], {
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME
  }
})

const systemCache = () => gate.envelopes.map(envelope => envelope.prompt[0].content[0].cache)

beforeEach(async () => {
  ws = outsideWorkspace('cache-lifetime')
  gate = await startGate({ mo: scriptedMo(async () => answers('done')), name: 'cache-lifetime' })
})

afterEach(async () => {
  await gate.close()
  rmSync(ws, { recursive: true, force: true })
})

describe('the root\'s prompt-cache lifetime', () => {
  it('is five minutes when the definition names none', async () => {
    await spore('hello')
    expect(systemCache()).toEqual(['5m'])
  })

  it('is what cache: names', async () => {
    const definition = resolve(ws, 'spore.cmk')
    writeFileSync(definition, readFileSync(definition, 'utf8').replace(/^---\n/, '---\ncache: 1h\n'))
    await spore('hello')
    expect(systemCache()).toEqual(['1h'])
  })
})
