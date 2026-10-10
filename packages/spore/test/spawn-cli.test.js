import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { outsideRoot } from './fixtures/outside-ws.js'

const run = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const SPAWN = resolve(__dirname, '../native/spore-spawn')
const ROOT = resolve(__dirname, '.spawn-cli-workspace')

const spawnCli = async (args, env = {}) => {
  try {
    const { stdout, stderr } = await run(SPAWN, args, { cwd: ROOT, env: { ...process.env, ...env } })
    return { code: 0, stdout, stderr }
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr }
  }
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(resolve(ROOT, 'work/1'), { recursive: true })
  mkdirSync(resolve(ROOT, 'precursors'), { recursive: true })
  writeFileSync(resolve(ROOT, 'precursors/summarize.cmk'), '---\nname: summarize\ntools: [read]\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: discard\n---\n\nYou summarize.\n')
  writeFileSync(resolve(ROOT, 'work/1/in.md'), 'material')
})

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

const ARGS = ['--precursor', 'summarize', '--ws', 'work/1', '--prompt', 'in.md', '--answer', 'data/out.json']

describe('the spawn command', () => {
  it('refuses --standalone inside a turn, whose cells are counted through its own socket', async () => {
    const r = await spawnCli([...ARGS, '--standalone', '--node', process.execPath, '--session', 'x', '--chatgpt-helper', 'y'], { SPORE_OWNERS: 'a1b2c3' })
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/--standalone is a host's, run outside any turn/)
  })

  it('takes a gate only for a cell outside any turn, and only with the spore\'s auth', async () => {
    const inTurn = await spawnCli([...ARGS, '--gate', '/run/mohdel/data.sock', '--auth', 'a1'])
    expect(inTurn.code).toBe(2)
    expect(inTurn.stderr).toMatch(/--gate and --auth are a cell's outside any turn/)
    const unnamed = await spawnCli([...ARGS, '--standalone', '--node', process.execPath, '--session', 'x', '--chatgpt-helper', 'y', '--gate', '/run/mohdel/data.sock'])
    expect(unnamed.code).toBe(2)
    expect(unnamed.stderr).toMatch(/the spore names no auth — add auth: <id> to its spore.cmk/)
  })

  it('refuses to run inside a cell, so a fan-out cannot nest', async () => {
    const r = await spawnCli(ARGS, { SPORE_CELL: 'summarize' })
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/a cell cannot spawn/)
    expect(r.stderr).toMatch(/already the sub-agent "summarize"/)
  })

  // The workspace is under the repo, which the sandbox grants read to every agent,
  // so this is also the first thing a real spawn from here would be told.
  it('reports a plan it cannot make without starting a child', async () => {
    const r = await spawnCli(ARGS)
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/inside a sandbox-granted path/)
    expect(r.stdout).toBe('')
  })
})

describe('a cell outside any turn', () => {
  let outside
  const standalone = ['--standalone', '--node', process.execPath, '--session', 'x', '--chatgpt-helper', 'y']
  const cell = (frontmatter, body = '') => writeFileSync(resolve(outside, 'precursors/route-hook-forge.cmk'),
    `---\nname: route-hook-forge\ntools: [read, exec]\n${frontmatter}rounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: discard\n---\n\nYou judge a delivery.\n${body}`)
  const spawnOutside = (args) => run(SPAWN, args, { cwd: outside, env: { ...process.env, SPORE_OWNERS: '' } })
    .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }), e => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }))
  const asked = ['--precursor', 'route-hook-forge', '--ws', 'work/1', '--prompt', 'in.md', '--answer', 'data/out.json', ...standalone]

  beforeEach(() => {
    outside = outsideRoot('spawn-standalone')
    mkdirSync(resolve(outside, 'work/1'), { recursive: true })
    mkdirSync(resolve(outside, 'precursors'), { recursive: true })
    writeFileSync(resolve(outside, 'work/1/in.md'), 'a delivery')
  })

  afterEach(() => rmSync(outside, { recursive: true, force: true }))

  it('is refused an enzyme, which would run in a broker no agent confines', async () => {
    cell('enzymes: [sh=/bin/sh]\n', '\n:::enzyme sh\nsh — runs what it is given.\n:::\n')
    const r = await spawnOutside(asked)
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/declares enzymes, and a cell outside any turn is refused both/)
  })

  it('is refused a read, which would be its own grant over the host', async () => {
    cell('reads: [/etc]\n')
    const r = await spawnOutside(asked)
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/declares reads, and a cell outside any turn is refused both/)
  })
})
