import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { writeTurnRecords } from '../../spore/src/core/spore-dir.js'
import { manage } from '../src/dispatch.js'

const DIR = resolve(tmpdir(), 'spore-dispatch-test')

const workspace = (path, turns) => {
  mkdirSync(path, { recursive: true })
  writeFileSync(resolve(path, 'spore.cmk'), '---\nname: t\nmodel: anthropic/claude-haiku-4-5\ntools: [read]\nrounds: [2, 3]\ncost: [0.1, 0.2]\nwall: [1m, 2m]\n---\n\nyou are a test.\n')
  writeTurnRecords(path, turns)
  return path
}

const printed = async (run) => {
  const said = []
  const [out, error] = [console.log, console.error]
  console.log = (line) => said.push(line)
  console.error = (line) => said.push(line)
  try {
    return { code: await run(), said }
  } finally {
    console.log = out
    console.error = error
  }
}

beforeEach(() => {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
})
afterEach(() => rmSync(DIR, { recursive: true, force: true }))

describe('the command, over the library', () => {
  // The read verbs answer about where you are; this one makes something, so it has to be
  // told what. A bare `define` in a directory holding a spore.cmk reported that it was
  // already defined, which answers a question nobody asked.
  it('refuses to fall back to the current directory, because defining is making', async () => {
    const { code, said } = await printed(() => manage('define', { _: ['define'] }))
    expect(code).toBe(2)
    expect(said.join(' ')).toMatch(/define needs a name/)
  })

  it('prints one breakdown of usage with --by, and refuses an axis it does not have', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const ws = workspace(resolve(DIR, 'one'), [{ startedAt: `${today}T00:00:01.000Z`, stopReason: 'answer', concluded: true, settled: true, model: 'anthropic/some-model', treeMicros: 10_000, rounds: 1 }])

    const shown = await printed(() => manage('usage', { _: ['usage', ws], by: 'model', tz: 'UTC' }))
    const refused = await printed(() => manage('usage', { _: ['usage', ws], by: 'weekday' }))

    expect(shown.code).toBe(0)
    expect(shown.said.join('\n')).toMatch(/anthropic\/some-model\s+1\s+0\s+\$0\.0100\s+100%/)
    expect(shown.said.join('\n')).not.toMatch(/█/)
    expect(refused.code).toBe(2)
    expect(refused.said.at(-1)).toMatch(/--by is one of day, spore, origin, model, outcome, precursor/)
  })
})
