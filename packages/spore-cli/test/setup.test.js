import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CONFIG_DIR, defaultModel, getKey, isWorkspace, readConfig } from '@rhizogrip/spore'
import { outsideRoot } from '@rhizogrip/spore/testing'

import { pickFromList, setup } from '../src/setup.js'

const base = process.env.SPORE_TEST_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../../../../tmp/spore-tests')

let root
let said
let asked
let onboarded
let acted

const scripted = (answers) => async (question) => {
  asked.push(question)
  const found = Object.entries(answers).find(([pattern]) => new RegExp(pattern).test(question))
  if (!found) throw new Error(`setup asked what the test did not expect: ${question}`)
  return found[1]
}

const picks = (...values) => async ({ items }) => {
  const value = values.shift()
  expect(value === null || items.some(item => item.value === value)).toBe(true)
  return value
}

const OPENROUTER = [
  { model: 'openrouter/priced', billing: 'metered', priced: true },
  { model: 'openrouter/unpriced', billing: 'metered', priced: false }
]

const mohdelWith = ({ ready = new Set(), models = OPENROUTER } = {}) => ({
  ready,
  loadKeys: () => {},
  modelReadiness: async (model) => ready.has(model.split('/')[0])
    ? { model, ready: true, priced: models.find(one => one.model === model)?.priced ?? true, fix: null }
    : { model, ready: false, fix: `mo onboard ${model.split('/')[0]}` },
  providerReadiness: async (provider) => ({ provider, credential: ready.has(provider), models: models.length, ready: ready.has(provider), fix: `mo onboard ${provider}` }),
  modelsOf: async (provider) => models.filter(one => provider === null || one.model.startsWith(`${provider}/`))
})

const servicesWith = (tick) => ({
  show: () => tick,
  define: (name) => { acted.push(['define', name]); tick.defined = true },
  act: (verb, name) => { acted.push([verb, name]); if (verb === 'enable') tick.enabled = true }
})

const run = (options = {}) => {
  const mohdel = options.mohdel ?? mohdelWith()
  return setup({
    say: (text) => said.push(text),
    prompt: scripted({}),
    pick: picks(),
    onboard: (provider) => { onboarded.push(provider); mohdel.ready.add(provider ?? 'openrouter'); return 0 },
    services: servicesWith({ defined: false, enabled: false }),
    examine: () => ({ findings: [] }),
    report: async () => ({ findings: [] }),
    sqlite: () => '3.51.3',
    ...options,
    mohdel
  })
}

beforeEach(() => {
  rmSync(CONFIG_DIR, { recursive: true, force: true })
  mkdirSync(CONFIG_DIR, { recursive: true })
  root = outsideRoot('spore-setup', base)
  said = []
  asked = []
  onboarded = []
  acted = []
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('spore setup', () => {
  it('takes a fresh machine through home, a provider, the default model, the tick timer and a first spore', async () => {
    const home = join(root, 'spores')
    const code = await run({
      prompt: scripted({ 'live\\?': home, 'tick timer': 'y' }),
      pick: picks('openrouter', 'openrouter/priced')
    })
    expect(code).toBe(0)
    expect(readConfig().home).toBe(home)
    expect(onboarded).toEqual(['openrouter'])
    expect(defaultModel().model).toBe('openrouter/priced')
    expect(acted).toEqual([['define', 'tick'], ['enable', 'tick'], ['start', 'tick']])
    expect(isWorkspace(join(home, 'main'))).toBe(true)
    expect(said).toContain(`made      main, your first spore, in ${join(home, 'main')}`)
    expect(said).toContain('  spore tui main                talk to main in a terminal screen')
    expect(said.some(text => /another model: \/curate in spore tui, or mo curate openrouter/.test(text))).toBe(true)
  })

  it('stops after spore doctor\'s problems, making no spore and offering no next step', async () => {
    const home = join(root, 'spores')
    const code = await run({
      prompt: scripted({ 'live\\?': home, 'tick timer': 'n' }),
      pick: picks('openrouter', 'openrouter/priced'),
      report: async () => ({ findings: [{ area: 'services', subject: 'tick', severity: 'problem', problem: 'is failing', fix: 'spore service log tick' }] })
    })
    expect(code).toBe(1)
    expect(said.at(-1)).toBe('fix those, then spore setup again — spore doctor checks just that part')
    expect(isWorkspace(join(home, 'main'))).toBe(false)
  })

  it('asks nothing a second time once each step is done', async () => {
    const mohdel = mohdelWith()
    await run({ mohdel, prompt: scripted({ 'live\\?': join(root, 'spores'), 'tick timer': 'y' }), pick: picks('openrouter', 'openrouter/priced') })
    asked = []
    onboarded = []
    const code = await run({ mohdel, services: servicesWith({ defined: true, enabled: true }), pick: async () => { throw new Error('picked again') } })
    expect(code).toBe(0)
    expect(asked).toEqual([])
    expect(onboarded).toEqual([])
    expect(said).toContain('spores    main')
    expect(said).toContain('checked   this machine, your config and your spores — nothing to fix')
    expect(said.at(-1)).toMatch(/^ {2}spore {25}every command$/)
  })

  it('says a model chosen without prices counts as $0, and how to fill them', async () => {
    await run({ prompt: scripted({ 'live\\?': join(root, 'spores'), 'tick timer': 'n' }), pick: picks('openrouter', 'openrouter/unpriced') })
    expect(said.find(line => line.startsWith('model'))).toMatch(/openrouter\/unpriced, no prices: its calls count as \$0.*mo model instructions openrouter/)
  })

  it('offers every ready provider\'s models after mohdel\'s own setup', async () => {
    const models = [...OPENROUTER, { model: 'gemini/flash', billing: 'metered', priced: true }]
    const mohdel = mohdelWith({ ready: new Set(['gemini']), models })
    let offered
    const pick = picks('another', 'gemini/flash')
    await run({
      mohdel,
      onboard: (provider) => { onboarded.push(provider); return 0 },
      prompt: scripted({ 'live\\?': join(root, 'spores'), 'tick timer': 'n' }),
      pick: async (menu) => { offered = menu.items.map(item => item.value); return pick(menu) }
    })
    expect(onboarded).toEqual([null])
    expect(offered).toEqual(['gemini/flash'])
    expect(defaultModel().model).toBe('gemini/flash')
  })

  it('stops when the provider is still not ready after mohdel\'s setup, naming what is missing', async () => {
    const code = await run({
      onboard: (provider) => { onboarded.push(provider); return 1 },
      prompt: scripted({ 'live\\?': join(root, 'spores') }),
      pick: picks('openrouter')
    })
    expect(code).toBe(1)
    expect(said.at(-1)).toMatch(/openrouter is not ready — mo onboard openrouter, then spore setup again/)
    expect(defaultModel().model).toBe(null)
  })

  it('offers to run uncontained on a host without namespaces, and stops when that is declined', async () => {
    const processes = { area: 'machine', subject: 'processes', severity: 'problem', problem: 'every turn is refused', fix: 'allow unprivileged user namespaces' }
    expect(await run({ examine: () => ({ findings: [processes] }), prompt: scripted({ uncontained: 'n' }) })).toBe(1)
    expect(getKey('contain')).toEqual({ contain: null })
    expect(said.at(-1)).toMatch(/allow unprivileged user namespaces, then spore setup again/)

    expect(await run({ examine: () => ({ findings: [processes] }), prompt: scripted({ uncontained: 'y', 'live\\?': join(root, 'spores') }), pick: picks(null) })).toBe(1)
    expect(getKey('contain')).toEqual({ contain: false })
  })

  it('stops at a kernel without Landlock before asking anything', async () => {
    const landlock = { area: 'machine', subject: 'landlock', severity: 'problem', problem: 'is not in this kernel', fix: 'run spore on Linux 5.13+' }
    expect(await run({ examine: () => ({ findings: [landlock] }) })).toBe(1)
    expect(asked).toEqual([])
  })

  it('stops first at a Node whose SQLite is too old', async () => {
    const tooOld = Object.assign(new Error('this Node\'s SQLite is 3.45.0'), { type: 'SQLITE_TOO_OLD' })
    await expect(run({ sqlite: () => { throw tooOld }, examine: () => { throw new Error('examined') } })).rejects.toBe(tooOld)
  })
})

describe('a pick on the plain terminal', () => {
  const ITEMS = Array.from({ length: 25 }, (_, i) => ({ value: `p/m${i + 1}`, label: `p/m${i + 1}`, description: i === 21 ? 'no prices' : 'metered' }))
  const answering = (...answers) => async () => answers.shift()

  it('takes a number from the list shown, the first twenty of a longer one', async () => {
    const lines = []
    expect(await pickFromList({ title: 't', items: ITEMS }, { prompt: answering('3'), say: (text) => lines.push(text) })).toBe('p/m3')
    expect(lines.filter(text => /^ +\d+ {2}p\//.test(text))).toHaveLength(20)
    expect(lines).toContain('  … and 5 more — words narrow the list')
  })

  it('narrows by words, numbering what is left, and says when a number or words match nothing', async () => {
    const lines = []
    const picked = await pickFromList({ title: 't', items: ITEMS }, { prompt: answering('99', 'nothing-here', 'no prices', '1'), say: (text) => lines.push(text) })
    expect(picked).toBe('p/m22')
    expect(lines).toContain('  99 is not in the list')
    expect(lines).toContain('  nothing matches nothing-here')
  })

  it('is left with an empty answer', async () => {
    expect(await pickFromList({ title: 't', items: ITEMS }, { prompt: answering(''), say: () => {} })).toBe(null)
  })
})
