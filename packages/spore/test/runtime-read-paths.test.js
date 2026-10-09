import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getNodeModulesRoot, grantedPathContaining, systemReadPaths } from '../src/isolation/sandbox.js'
import { makeTools } from '../src/tools/make-tools.js'
import { createCallTrail } from '../src/core/call-record.js'
import { hostState } from '../src/core/spore-dir.js'
import { shownToModel } from './fixtures/as-shown.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const WS = resolve(__dirname, '.runtime-read-workspace')

const under = (p) => p.startsWith(ROOT + '/') ? p.slice(ROOT.length + 1) : null

describe('what a confined agent may read of the checkout', () => {
  it('is the runtime and nothing else', () => {
    const granted = systemReadPaths().map(under).filter(Boolean).filter(path => path !== 'node_modules').sort()
    expect(granted).toEqual(['bin', 'build', 'native', 'package.json', 'sporangia', 'src'])
    expect(systemReadPaths()).not.toContain(ROOT)
    expect(systemReadPaths()).toContain(getNodeModulesRoot())
  })

  it('includes the directory of the node running spore, wherever it is installed', () => {
    expect(systemReadPaths()).toContain(dirname(realpathSync(process.execPath)))
  })

  // A workspace inside the checkout is refused for its own reason, and narrowing what an
  // agent reads must not quietly lift it.
  it('still refuses the checkout as a place for a workspace', () => {
    for (const at of ['.', 'test', 'conformance', 'sporangia']) {
      expect(grantedPathContaining(resolve(ROOT, at)), at).toBeTruthy()
    }
  })
})

describe('under confine', () => {
  let exec

  beforeEach(() => {
    rmSync(WS, { recursive: true, force: true })
    mkdirSync(resolve(WS, 'data'), { recursive: true })
    exec = shownToModel(makeTools(WS, 50000, createCallTrail(WS, { runId: 'reads', state: hostState(WS) })).fns).exec
  })

  afterEach(() => rmSync(WS, { recursive: true, force: true }))

  const run = async (command) => JSON.parse(await exec({ command, out: 'data/o.txt' })).exit

  // The positive half is what makes the negative half mean anything: a sandbox that denied
  // everything would pass every refusal below.
  it('can still read and run the runtime', async () => {
    expect(await run(`cat ${ROOT}/package.json > /dev/null`)).toBe(0)
    expect(await run(`ls ${dirname(createRequire(import.meta.url).resolve('minimist/package.json'))} > /dev/null`)).toBe(0)
    expect(await run(`node ${ROOT}/bin/fanout.js --help > /dev/null`)).toBe(0)
  })

  it('cannot read a test fixture, the conformance graders or the design', async () => {
    const refused = [resolve(ROOT, 'test/fixtures/scripted-model.js'), resolve(ROOT, 'conformance'), resolve(ROOT, '../../ARCHITECTURE.md')]
    for (const path of refused) expect(existsSync(path), path).toBe(true)
    expect(await run(`cat ${refused[0]} > /dev/null`)).not.toBe(0)
    expect(await run(`ls ${refused[1]} > /dev/null`)).not.toBe(0)
    expect(await run(`cat ${refused[2]} > /dev/null`)).not.toBe(0)
  })
})
