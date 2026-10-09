/**
 * The spend limits, from the config file through `spore send`: once what the user's spores
 * settled reaches one, no turn starts and nothing is said.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { outsideRoot, outsideWorkspace } from './fixtures/outside-ws.js'
import { spendSoFar } from '../src/core/admission.js'
import { readInbox, readTurns } from '../src/core/spore-dir.js'

const run = promisify(execFile)
const SPORE = resolve(dirname(fileURLToPath(import.meta.url)), '../../spore-cli/bin/spore.js')

let ws
let home

const configure = (settings) => {
  mkdirSync(resolve(home, 'config', 'spore'), { recursive: true })
  writeFileSync(resolve(home, 'config', 'spore', 'config.json'), JSON.stringify(settings))
}

const spent = (micros) => {
  const { date } = spendSoFar({ dir: resolve(home, 'state', 'spore', 'slots'), config: {} })
  mkdirSync(resolve(home, 'state', 'spore', 'spend'), { recursive: true })
  writeFileSync(resolve(home, 'state', 'spore', 'spend', date), String(micros))
}

const spore = async (...args) => {
  try {
    const { stdout, stderr } = await run(process.execPath, [SPORE, ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_STATE_HOME: resolve(home, 'state'), XDG_CONFIG_HOME: resolve(home, 'config') }
    })
    return { code: 0, stdout, stderr }
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr }
  }
}

beforeEach(() => {
  ws = outsideWorkspace('spend-limits')
  home = outsideRoot('spend-config')
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

describe('spores at their spend limit', () => {
  it('starts no turn and says nothing, naming the limit it reached', async () => {
    configure({ spendPerMonth: 30 })
    spent(30_000_000)

    const result = await spore('send', ws, 'hello')
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/your spores have spent \$30\.00 this month, which reaches your monthly limit of \$30\.00/)
    expect(readInbox(ws)).toEqual([])
    expect(readTurns(ws)).toEqual([])
  })

  it('is shown under spore ls, with how far each window has gone', async () => {
    configure({ home: resolve(home, 'spores'), spendPerDay: 2, spendPerMonth: 30 })
    spent(2_500_000)

    const result = await spore('ls')
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/your spores have spent today \$2\.50 of \$2\.00 — reached, no turn starts · \w+ \$2\.50 of \$30\.00/)
  })
})
