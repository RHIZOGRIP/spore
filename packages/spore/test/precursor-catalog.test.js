import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { cellModelRules, copyAbsent, describePrecursors, precursorRules, seedPrecursors } from '../src/delegation/precursor-catalog.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.catalog-workspace')

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
})

afterEach(() => {
  rmSync(WS, { recursive: true, force: true })
})

const DOCS = resolve(__dirname, 'fixtures/plugins/docs/precursors')
const give = (...names) => {
  mkdirSync(resolve(WS, 'precursors'), { recursive: true })
  for (const name of names) copyFileSync(resolve(DOCS, `${name}.cmk`), resolve(WS, `precursors/${name}.cmk`))
}

describe('precursor catalog', () => {
  it('seeds the format into an empty workspace, and no precursor', () => {
    expect(seedPrecursors(WS)).toEqual(['README.md'])
    expect(readdirSync(resolve(WS, 'precursors'))).toEqual(['README.md'])
  })

  it('never overwrites one someone has changed', () => {
    seedPrecursors(WS)
    writeFileSync(resolve(WS, 'precursors/README.md'), 'Mine now.')
    expect(seedPrecursors(WS)).toEqual([])
    expect(readFileSync(resolve(WS, 'precursors/README.md'), 'utf8')).toBe('Mine now.')
  })

  it('never writes through a link it finds where it would copy', () => {
    mkdirSync(resolve(WS, 'precursors'))
    const target = resolve(WS, 'elsewhere.md')
    symlinkSync(target, resolve(WS, 'precursors/README.md'))
    expect(seedPrecursors(WS)).toEqual([])
    expect(existsSync(target)).toBe(false)
    expect(copyAbsent(resolve(DOCS, 'review.cmk'), resolve(WS, 'precursors/README.md'))).toBe(false)
  })

  it('says one it cannot read is unusable, and still describes the rest', () => {
    give('review')
    symlinkSync('gone.cmk', resolve(WS, 'precursors/dangling.cmk'))
    const found = describePrecursors(WS)
    expect(found.find(p => p.name === 'dangling')).toEqual({ name: 'dangling', error: 'cannot be read — ENOENT' })
    expect(found.find(p => p.name === 'review')?.error).toBeUndefined()
  })

  it('describes each one by name, summary and grants', () => {
    give('review', 'summarize')
    const found = describePrecursors(WS)
    const review = found.find(p => p.name === 'review')
    expect(review.tools).toEqual(['read', 'exec'])
    expect(review.summary).toMatch(/review code/)
    expect(precursorRules(found)).toMatch(/review \(precursors\/review\.cmk\)/)
    expect(found.find(p => p.name === 'summarize').tools).toEqual([])
  })

  it('surfaces a broken precursor instead of hiding it', () => {
    mkdirSync(resolve(WS, 'precursors'), { recursive: true })
    writeFileSync(resolve(WS, 'precursors/broken.cmk'), '---\nname: broken\nweather: sunny\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\n---\nbody')
    const rules = precursorRules(describePrecursors(WS))
    expect(rules).toMatch(/broken \(precursors\/broken\.cmk\) — unusable until fixed: unknown field "weather"/)
  })

  it('says nothing when a workspace has none', () => {
    expect(describePrecursors(WS)).toEqual([])
    expect(precursorRules([])).toBe('')
  })
})

describe('the models a sub-agent may run on', () => {
  it('are listed with what they stand for, and nothing is said when the spore has none', () => {
    expect(cellModelRules([], 'm/root')).toBe('')
    expect(cellModelRules([{ name: 'low', model: 'm/cheap' }, { name: 'strong', model: 'm/best' }], 'm/root')).toBe([
      'Models a sub-agent can run on, named by model: in its precursor — one naming none runs on yours, m/root:',
      '- low: m/cheap',
      '- strong: m/best',
      'Any other name is refused when the sub-agent is spawned.'
    ].join('\n'))
  })

  it('shows each precursor\'s own beside its tools', () => {
    mkdirSync(resolve(WS, 'precursors'), { recursive: true })
    writeFileSync(resolve(WS, 'precursors', 'review.cmk'), '---\nname: review\nmodel: strong\ntools: [read]\nrounds: [5, 7]\ncost: [0.1, 0.2]\nwall: [2m, 3m]\non-wrap: keep\n---\n\nYou review.\n')
    expect(precursorRules(describePrecursors(WS))).toMatch(/- review \(precursors\/review\.cmk\) — You review\. \(tools: read; model: strong\)/)
  })
})
