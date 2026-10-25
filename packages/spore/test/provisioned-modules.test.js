import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { promisify } from 'node:util'

import { PROVISIONED_MODULES, agentEnv } from '../src/delegation/agent-env.js'
import { openWorkspace } from '../src/core/workspace.js'
import { definitionWith } from '../src/testing.js'

const run = promisify(execFile)

// Outside the repo, unlike every other suite here, and that is the point: node walks
// up from the importing file, so a workspace under this checkout would resolve every
// dependency spore has and prove nothing about what was provisioned.
let ROOT = null
let WS = null

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'spore-provisioned-'))
  WS = resolve(ROOT, 'ws')
  mkdirSync(WS, { recursive: true })
  writeFileSync(resolve(WS, 'spore.cmk'), definitionWith('anthropic/claude-haiku-4-5'))
})

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

// These are dependencies of this package for the agent's sake: the answer to "read
// this spreadsheet" is a program it writes. Declaring them is not enough — node
// resolves a bare import by walking up from `<ws>/data/`, which never reaches this
// package, so the access itself is the thing to assert.
describe('the libraries an agent\'s programs may import', () => {
  it('resolves every declared one from a program in the workspace', async () => {
    expect(openWorkspace('ws', { cwd: ROOT, allowGranted: true }).error).toBeUndefined()

    // ESM, because that is what the identity asks the agent to write, and NODE_PATH
    // would have covered only `require`.
    writeFileSync(resolve(WS, 'data', 'probe.mjs'), `
      for (const name of ${JSON.stringify(PROVISIONED_MODULES)}) {
        await import(name)
        console.log(name)
      }
    `)

    // The environment the agent's own shell hands on, not this test runner's.
    const { stdout } = await run(process.execPath, ['data/probe.mjs'], { cwd: WS, env: agentEnv(process.env) })
    expect(stdout.split('\n').filter(Boolean)).toEqual(PROVISIONED_MODULES)
  }, 30000)

  it('offers only what is declared', async () => {
    openWorkspace('ws', { cwd: ROOT, allowGranted: true })
    writeFileSync(resolve(WS, 'data', 'probe.mjs'), "await import('chalk')")
    await expect(run(process.execPath, ['data/probe.mjs'], { cwd: WS, env: agentEnv(process.env) }))
      .rejects.toThrow(/ERR_MODULE_NOT_FOUND/)
  }, 30000)
})
