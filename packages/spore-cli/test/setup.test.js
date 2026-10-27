import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CANCEL_SYMBOL } from '@clack/prompts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CONFIG_DIR, defaultModel, describeHost, getKey, isWorkspace, readConfig } from '@rhizogrip/spore'
import { outsideRoot } from '@rhizogrip/spore/testing'

import { pickFromList, setup } from '../src/setup.js'

const given = vi.hoisted(() => ({}))

vi.mock('@clack/prompts', async (real) => {
  const actual = await real()
  const say = (message) => given.say(message)
  return {
    ...actual,
    intro: () => {},
    outro: say,
    note: (message, title) => given.say([title, ...message.split('\n')]),
    log: { ...actual.log, message: say, info: say, success: say, step: say, warn: say, warning: say, error: say },
    text: async ({ message, defaultValue }) => (await given.answer(message)) || defaultValue,
    confirm: async ({ message }) => /^y/.test(await given.answer(message)),
    autocomplete: async (opts) => given.pick(opts)
  }
})
vi.mock('node:child_process', async (real) => {
  const actual = await real()
  return {
    ...actual,
    spawnSync: (command, args, options) => args?.[1] === 'onboard' ? { status: given.onboard(args[2] ?? null) } : actual.spawnSync(command, args, options)
  }
})
vi.mock('@rhizogrip/spore', async (real) => ({
  ...await real(),
  checkSqlite: () => given.sqlite(),
  doctor: () => given.examine(),
  loadMohdelEnvironment: () => {},
  modelReadiness: (model) => given.mohdel.modelReadiness(model),
  modelsOf: (provider) => given.mohdel.modelsOf(provider),
  providerReadiness: (provider) => given.mohdel.providerReadiness(provider)
}))
vi.mock('../src/services.js', async (real) => ({ ...await real(), createServices: () => given.services }))
vi.mock('../src/doctor.js', async (real) => ({ ...await real(), diagnose: async () => given.report() }))

const base = process.env.SPORE_TEST_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../../../../tmp/spore-tests')

let root
let said
let asked
let onboarded
let acted
let offers

const offered = (title) => offers.findLast(offer => offer.message.startsWith(title)).labels

/** A person at the terminal: a question answered by the first pattern it matches, a pick by the label of what to choose, or null to leave it. */
const person = (answers, picks) => ({
  answer: async (question) => {
    asked.push(question)
    const found = Object.entries(answers).find(([pattern]) => new RegExp(pattern).test(question))
    if (!found) throw new Error(`setup asked what the test did not expect: ${question}`)
    return found[1]
  },
  pick: async ({ message, options }) => {
    asked.push(message)
    offers.push({ message, labels: options.map(option => option.label) })
    if (!picks.length) throw new Error('setup offered a pick the test did not expect')
    const label = picks.shift()
    if (label === null) return CANCEL_SYMBOL
    const option = options.find(one => one.label === label)
    if (!option) throw new Error(`${label} was not offered`)
    return option.value
  }
})

const OPENROUTER = [
  { model: 'openrouter/priced', billing: 'metered', priced: true },
  { model: 'openrouter/unpriced', billing: 'metered', priced: false }
]

const mohdelWith = ({ ready = new Set(), models = OPENROUTER } = {}) => ({
  ready,
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

const HELD = ['read a file outside what it is granted', 'make namespaces of its own'].map(tried => ({ tried, outcome: 'refused', why: 'Permission denied' }))

const run = ({
  answers = {},
  picks = [],
  mohdel = mohdelWith(),
  onboard = (provider) => { onboarded.push(provider); mohdel.ready.add(provider ?? 'openrouter'); return 0 },
  services = servicesWith({ defined: false, enabled: false }),
  examine = () => ({ findings: [] }),
  report = async () => ({ findings: [], boundary: HELD, host: describeHost() }),
  sqlite = () => '3.51.3'
} = {}) => {
  Object.assign(given, { ...person(answers, picks), mohdel, onboard, services, examine, report, sqlite })
  return setup()
}

beforeEach(() => {
  rmSync(CONFIG_DIR, { recursive: true, force: true })
  mkdirSync(CONFIG_DIR, { recursive: true })
  root = outsideRoot('spore-setup', base)
  said = []
  asked = []
  onboarded = []
  acted = []
  offers = []
  given.say = (message) => said.push(...[].concat(message).flatMap(text => text.split('\n')))
  vi.spyOn(console, 'log').mockImplementation((text = '') => { said.push(text) })
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('spore setup', () => {
  it('takes a fresh machine through home, a provider, the default model, the tick timer and a first spore', async () => {
    const home = join(root, 'spores')
    const code = await run({
      answers: { 'live\\?': home, 'tick timer': 'y' },
      picks: ['OpenRouter', 'openrouter/priced']
    })
    expect(code).toBe(0)
    expect(readConfig().home).toBe(home)
    expect(onboarded).toEqual(['openrouter'])
    expect(defaultModel().model).toBe('openrouter/priced')
    expect(acted).toEqual([['define', 'tick'], ['enable', 'tick'], ['start', 'tick']])
    expect(isWorkspace(join(home, 'main'))).toBe(true)
    expect(said).toContain(`made      main, your first spore, in ${join(home, 'main')}`)
    expect(said).toContain('spore tui main                talk to main in a terminal screen')
    expect(said.some(text => /another model: \/curate in spore tui, or mo curate openrouter/.test(text))).toBe(true)
  })

  it('says what a turn\'s commands tried on this machine and were refused, once nothing is wrong', async () => {
    expect(await run({ answers: { 'live\\?': join(root, 'spores'), 'tick timer': 'n' }, picks: ['OpenRouter', 'openrouter/priced'] })).toBe(0)
    expect(said).toContain('boundary  a turn\'s commands tried 2 ways out here and were refused every one — spore doctor lists them')
  })

  it('counts what was refused when a way out was not, as on a host running uncontained', async () => {
    const crossed = [...HELD, { tried: 'see a process outside it', outcome: 'crossed', why: 'contain is off' }]
    expect(await run({ answers: { 'live\\?': join(root, 'spores'), 'tick timer': 'n' }, picks: ['OpenRouter', 'openrouter/priced'], report: async () => ({ findings: [], boundary: crossed, host: describeHost() }) })).toBe(0)
    expect(said).toContain('boundary  a turn\'s commands tried 3 ways out here and were refused 2 — spore doctor lists them')
  })

  it('stops after spore doctor\'s problems, making no spore and offering no next step', async () => {
    const home = join(root, 'spores')
    const code = await run({
      answers: { 'live\\?': home, 'tick timer': 'n' },
      picks: ['OpenRouter', 'openrouter/priced'],
      report: async () => ({ findings: [{ area: 'services', subject: 'tick', severity: 'problem', problem: 'is failing', fix: 'spore service log tick' }], boundary: HELD, host: describeHost() })
    })
    expect(code).toBe(1)
    expect(said.at(-1)).toBe('fix those, then spore setup again — spore doctor checks just that part')
    expect(isWorkspace(join(home, 'main'))).toBe(false)
  })

  it('asks nothing a second time once each step is done', async () => {
    const mohdel = mohdelWith()
    await run({ mohdel, answers: { 'live\\?': join(root, 'spores'), 'tick timer': 'y' }, picks: ['OpenRouter', 'openrouter/priced'] })
    asked = []
    onboarded = []
    const code = await run({ mohdel, services: servicesWith({ defined: true, enabled: true }) })
    expect(code).toBe(0)
    expect(asked).toEqual([])
    expect(onboarded).toEqual([])
    expect(said).toContain('spores    main')
    expect(said).toContain('checked   this machine, your config and your spores — nothing to fix')
    expect(said.slice(-2)).toEqual([`spore${' '.repeat(25)}every command`, 'spore setup again checks all of this'])
  })

  it('says a model chosen without prices counts as $0, and how to fill them', async () => {
    await run({ answers: { 'live\\?': join(root, 'spores'), 'tick timer': 'n' }, picks: ['OpenRouter', 'openrouter/unpriced'] })
    expect(said.find(line => line.startsWith('model'))).toMatch(/openrouter\/unpriced, no prices: its calls count as \$0.*mo model instructions openrouter/)
  })

  it('offers every ready provider\'s models after mohdel\'s own setup', async () => {
    const models = [...OPENROUTER, { model: 'gemini/flash', billing: 'metered', priced: true }]
    const mohdel = mohdelWith({ ready: new Set(['gemini']), models })
    await run({
      mohdel,
      onboard: (provider) => { onboarded.push(provider); return 0 },
      answers: { 'live\\?': join(root, 'spores'), 'tick timer': 'n' },
      picks: ['another provider', 'gemini/flash']
    })
    expect(onboarded).toEqual([null])
    expect(offered('the model new spores run on')).toEqual(['gemini/flash'])
    expect(defaultModel().model).toBe('gemini/flash')
  })

  it('stops when the provider is still not ready after mohdel\'s setup, naming what is missing', async () => {
    const code = await run({
      onboard: (provider) => { onboarded.push(provider); return 1 },
      answers: { 'live\\?': join(root, 'spores') },
      picks: ['OpenRouter']
    })
    expect(code).toBe(1)
    expect(said.at(-1)).toMatch(/openrouter is not ready — mo onboard openrouter, then spore setup again/)
    expect(defaultModel().model).toBe(null)
  })

  it('offers to run uncontained on a host without namespaces, and stops when that is declined', async () => {
    const processes = { area: 'machine', subject: 'processes', severity: 'problem', problem: 'every turn is refused', fix: 'allow unprivileged user namespaces' }
    expect(await run({ examine: () => ({ findings: [processes] }), answers: { uncontained: 'n' } })).toBe(1)
    expect(getKey('contain')).toEqual({ contain: null })
    expect(said.slice(-2)).toEqual(['allow unprivileged user namespaces', 'then spore setup again'])

    expect(await run({ examine: () => ({ findings: [processes] }), answers: { uncontained: 'y', 'live\\?': join(root, 'spores') }, picks: [null] })).toBe(1)
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

describe('a pick from a list', () => {
  const ITEMS = Array.from({ length: 25 }, (_, i) => ({ value: `p/m${i + 1}`, label: `p/m${i + 1}`, description: i === 21 ? 'no prices' : 'metered' }))
  let shown
  const picking = (answer) => { given.pick = async (opts) => { shown = opts; return answer } }

  it('shows twenty at a time, and returns the value picked', async () => {
    picking('p/m3')
    expect(await pickFromList({ title: 't', header: ['h'], items: ITEMS })).toBe('p/m3')
    expect(shown.maxItems).toBe(20)
    expect(shown.message).toBe('t\nh')
    expect(shown.options[21]).toEqual({ value: 'p/m22', label: 'p/m22', hint: 'no prices' })
  })

  it('narrows by every word typed, in the label or the description', async () => {
    picking('p/m1')
    await pickFromList({ title: 't', items: ITEMS })
    const left = (search) => shown.options.filter(option => shown.filter(search, option)).map(option => option.value)
    expect(left('no prices')).toEqual(['p/m22'])
    expect(left('M22 PRICES')).toEqual(['p/m22'])
    expect(left('metered p/m2')).toEqual(['p/m2', 'p/m20', 'p/m21', 'p/m23', 'p/m24', 'p/m25'])
    expect(left('nothing-here')).toEqual([])
  })

  it('is left when the person leaves it', async () => {
    picking(CANCEL_SYMBOL)
    expect(await pickFromList({ title: 't', items: ITEMS })).toBe(null)
  })
})
