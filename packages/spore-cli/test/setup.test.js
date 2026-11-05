import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { CANCEL_SYMBOL } from '@clack/prompts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CONFIG_DIR, defaultModel, describeHost, getKey, isWorkspace, readConfig, setDefaultModel } from '@rhizogrip/spore'
import { outsideRoot } from '@rhizogrip/spore/testing'

import { pickFromList, setup, setupModel } from '../src/setup.js'

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
    spawnSync: (command, args, options) => {
      if (args?.[1] === 'curate') return { status: given.curate(args[2]) }
      if (args?.[1] !== 'onboard') return actual.spawnSync(command, args, options)
      const rest = args.slice(2)
      const at = rest.indexOf('--caller')
      if (at === -1 || rest[at + 1] !== 'spore') throw new Error(`setup ran mo onboard without --caller spore: ${rest.join(' ')}`)
      rest.splice(at, 2)
      return { status: given.onboard(rest[0], rest.includes('--credential-only')) }
    }
  }
})
vi.mock('@rhizogrip/spore', async (real) => ({
  ...await real(),
  checkSqlite: () => given.sqlite(),
  doctor: () => given.examine(),
  loadMohdelEnvironment: () => {},
  modelReadiness: (model) => given.mohdel.modelReadiness(model),
  modelsOf: (provider) => given.mohdel.modelsOf(provider),
  providerReadiness: (provider) => given.mohdel.providerReadiness(provider),
  tagModel: async (model, tag) => { tagged.push([model, tag]) },
  mohdexRecommended: (query) => given.mohdex.recommended(query),
  mohdexEntries: (provider) => given.mohdex.entries(provider),
  addFromMohdex: (picked) => given.mohdex.add(picked)
}))
vi.mock('../src/services.js', async (real) => ({ ...await real(), createServices: () => given.services }))
vi.mock('../src/doctor.js', async (real) => ({ ...await real(), diagnose: async () => given.report() }))

let root
let said
let asked
let onboarded
let credentialOnly
let added
let tagged
let acted
let offers

const offered = (title) => offers.findLast(offer => offer.message.startsWith(title)).labels
const hints = (title) => offers.findLast(offer => offer.message.startsWith(title)).hints

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
    offers.push({ message, labels: options.map(option => option.label), hints: options.map(option => option.hint) })
    if (!picks.length) throw new Error('setup offered a pick the test did not expect')
    const label = picks.shift()
    if (label === null) return CANCEL_SYMBOL
    const option = options.find(one => one.label === label)
    if (!option) throw new Error(`${label} was not offered`)
    return option.value
  }
})

const OPENROUTER = [
  { model: 'openrouter/priced', type: 'model', tags: [], billing: 'metered', priced: true },
  { model: 'openrouter/unpriced', type: 'model', tags: [], billing: 'metered', priced: false }
]

const billingOf = (model) => model.startsWith('chatgpt/') ? 'plan' : 'metered'

const mohdelWith = ({ ready = new Set(), models = OPENROUTER } = {}) => ({
  ready,
  modelReadiness: async (model) => ready.has(model.split('/')[0])
    ? { model, billing: billingOf(model), ready: true, priced: models.find(one => one.model === model)?.priced ?? true, fix: null }
    : { model, billing: billingOf(model), ready: false, fix: `mo onboard ${model.split('/')[0]}` },
  providerReadiness: async (provider) => ({ provider, credential: ready.has(provider), models: models.length, ready: ready.has(provider), fix: `mo onboard ${provider}` }),
  modelsOf: async (provider) => models.filter(one => provider === null || one.model.startsWith(`${provider}/`))
})

const entryOf = (provider, model, inputPrice, outputPrice) => ({ provider, sdk: 'openai', model, creator: 'openai', inputPrice, outputPrice, inputFormat: ['text'] })

const ENTRIES = {
  'openai/gpt-dear': entryOf('openai', 'gpt-dear', 4, 20),
  'openai/gpt-cheap': entryOf('openai', 'gpt-cheap', 0.5, 2),
  'openai/gpt-tiered': entryOf('openai', 'gpt-tiered', { default: 1, '>272000': 2 }, { default: 5, '>272000': 7.5 }),
  'chatgpt/gpt-plan': entryOf('chatgpt', 'gpt-plan', 1, 5)
}

const RECOMMENDED = Object.keys(ENTRIES).map(key => ({ key, version: '1.56.0' }))

const mohdexWith = ({ recommended = RECOMMENDED, entries = ENTRIES } = {}) => ({
  recommended: async () => recommended,
  entries: async (provider) => Object.fromEntries(Object.entries(entries).filter(([key]) => key.startsWith(`${provider}/`))),
  add: async (picked) => { added.push(...picked) }
})

const unreachable = async () => { throw new Error('fetch failed') }

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
  mohdex = mohdexWith(),
  onboard = (provider, narrowed) => {
    onboarded.push(provider)
    if (narrowed) credentialOnly.push(provider)
    mohdel.ready.add(provider)
    return 0
  },
  services = servicesWith({ defined: false, enabled: false }),
  examine = () => ({ findings: [] }),
  report = async () => ({ findings: [], boundary: HELD, host: describeHost() }),
  sqlite = () => '3.51.3',
  curate = () => { throw new Error('setup ran mo curate') },
  verb = setup
} = {}) => {
  Object.assign(given, { ...person(answers, picks), mohdel, mohdex, onboard, curate, services, examine, report, sqlite })
  return verb()
}

beforeEach(() => {
  rmSync(CONFIG_DIR, { recursive: true, force: true })
  mkdirSync(CONFIG_DIR, { recursive: true })
  root = outsideRoot('spore-setup')
  said = []
  asked = []
  onboarded = []
  credentialOnly = []
  added = []
  tagged = []
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
      answers: { 'hold your spores\\?': home, 'tick timer': 'y' },
      picks: ['OpenAI', 'openai/gpt-cheap']
    })
    expect(code).toBe(0)
    expect(readConfig().home).toBe(home)
    expect(onboarded).toEqual(['openai'])
    expect(credentialOnly).toEqual(['openai'])
    expect(added).toEqual([{ key: 'openai/gpt-cheap', entry: ENTRIES['openai/gpt-cheap'] }])
    expect(defaultModel().model).toBe('openai/gpt-cheap')
    expect(tagged).toEqual([['openai/gpt-cheap', 'spore']])
    expect(acted).toEqual([['define', 'tick'], ['enable', 'tick'], ['start', 'tick']])
    expect(isWorkspace(join(home, 'main'))).toBe(true)
    expect(said).toContain(`made      main, your first spore, in ${join(home, 'main')}`)
    expect(said).toContain('spore tui main                talk to main in a terminal screen')
    expect(said).toContain('spore setup model             another recommended model, from any provider')
    expect(said.some(text => /or \/curate in spore tui, or mo curate openai, adds any other openai model/.test(text))).toBe(true)
  })

  it('says what a turn\'s commands tried on this machine and were refused, once nothing is wrong', async () => {
    expect(await run({ answers: { 'hold your spores\\?': join(root, 'spores'), 'tick timer': 'n' }, picks: ['OpenAI', 'openai/gpt-cheap'] })).toBe(0)
    expect(said).toContain('boundary  a turn\'s commands tried 2 ways out here and were refused every one — spore doctor lists them')
  })

  it('counts what was refused when a way out was not, as on a host running uncontained', async () => {
    const crossed = [...HELD, { tried: 'see a process outside it', outcome: 'crossed', why: 'contain is off' }]
    expect(await run({ answers: { 'hold your spores\\?': join(root, 'spores'), 'tick timer': 'n' }, picks: ['OpenAI', 'openai/gpt-cheap'], report: async () => ({ findings: [], boundary: crossed, host: describeHost() }) })).toBe(0)
    expect(said).toContain('boundary  a turn\'s commands tried 3 ways out here and were refused 2 — spore doctor lists them')
  })

  it('stops after spore doctor\'s problems, making no spore and offering no next step', async () => {
    const home = join(root, 'spores')
    const code = await run({
      answers: { 'hold your spores\\?': home, 'tick timer': 'n' },
      picks: ['OpenAI', 'openai/gpt-cheap'],
      report: async () => ({ findings: [{ area: 'services', subject: 'tick', severity: 'problem', problem: 'is failing', fix: 'spore service log tick' }], boundary: HELD, host: describeHost() })
    })
    expect(code).toBe(1)
    expect(said.at(-1)).toBe('fix those, then spore setup again — spore doctor checks just that part')
    expect(isWorkspace(join(home, 'main'))).toBe(false)
  })

  it('asks nothing a second time once each step is done', async () => {
    const mohdel = mohdelWith()
    await run({ mohdel, answers: { 'hold your spores\\?': join(root, 'spores'), 'tick timer': 'y' }, picks: ['OpenAI', 'openai/gpt-cheap'] })
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

  it('asks about the tick timer only until there is a spore, then says it is off', async () => {
    const mohdel = mohdelWith()
    await run({ mohdel, answers: { 'hold your spores\\?': join(root, 'spores'), 'tick timer': 'n' }, picks: ['OpenAI', 'openai/gpt-cheap'] })
    asked = []
    said = []
    expect(await run({ mohdel })).toBe(0)
    expect(asked).toEqual([])
    expect(said).toContain('tick      off — spore service define tick, then enable it, once a spore has a schedule')
  })

  it('says a model chosen without prices counts as $0, and how to fill them', async () => {
    await run({ answers: { 'hold your spores\\?': join(root, 'spores'), 'tick timer': 'n' }, picks: ['expert', 'OpenRouter', 'openrouter/unpriced'] })
    expect(said.find(line => line.startsWith('model'))).toMatch(/openrouter\/unpriced, no prices: its calls count as \$0.*mo model instructions openrouter/)
  })

  describe('expert', () => {
    const answers = () => ({ 'hold your spores\\?': join(root, 'spores'), 'tick timer': 'n' })
    const GEMINI = [
      { model: 'gemini/embed', type: 'embedding', tags: [], billing: 'metered', priced: true },
      { model: 'gemini/flash', type: 'model', tags: [], billing: 'metered', priced: true },
      { model: 'gemini/pro', type: 'model', tags: ['spore'], billing: 'metered', priced: true }
    ]

    it('offers every provider, runs mohdel\'s full onboarding for the one picked, and tags the model', async () => {
      await run({ mohdel: mohdelWith({ models: [...OPENROUTER, ...GEMINI] }), answers: answers(), picks: ['expert', 'Google Gemini', 'gemini/flash'] })
      expect(offered('which provider')).toContain('Groq')
      expect(onboarded).toEqual(['gemini'])
      expect(credentialOnly).toEqual([])
      expect(defaultModel().model).toBe('gemini/flash')
      expect(tagged).toEqual([['gemini/flash', 'spore']])
    })

    it('says which providers already have a credential', async () => {
      await run({ mohdel: mohdelWith({ ready: new Set(['chatgpt', 'gemini']) }), answers: answers(), picks: ['expert', null] })
      const { labels, hints: shown } = offers.at(-1)
      expect(shown[labels.indexOf('Google Gemini')]).toBe('key found')
      expect(shown[labels.indexOf('ChatGPT plan')]).toBe('signed in')
    })

    it('offers text models only, one chosen before first, then the way to another', async () => {
      await run({ mohdel: mohdelWith({ models: GEMINI }), answers: answers(), picks: ['expert', 'Google Gemini', 'gemini/flash'] })
      expect(offered('which model')).toEqual(['gemini/pro', 'gemini/flash', 'another gemini model'])
      expect(hints('which model').slice(0, 2)).toEqual(['metered, chosen before', 'metered'])
    })

    it('runs mo curate for a model the catalog lacks, then offers the list again', async () => {
      const models = [...GEMINI]
      const curated = []
      const curate = (provider) => {
        curated.push(provider)
        models.push({ model: 'gemini/new', type: 'model', tags: [], billing: 'metered', priced: true })
        return 0
      }
      await run({ mohdel: mohdelWith({ models }), curate, answers: answers(), picks: ['expert', 'Google Gemini', 'another gemini model', 'gemini/new'] })
      expect(curated).toEqual(['gemini'])
      expect(defaultModel().model).toBe('gemini/new')
    })

    it('still offers the way to a model when the catalog holds none of the provider', async () => {
      await run({ mohdel: mohdelWith({ models: [] }), answers: answers(), picks: ['expert', 'Google Gemini', null] })
      expect(offered('which model')).toEqual(['another gemini model'])
    })

    it('stops when the provider still has no credential, naming the fix', async () => {
      const code = await run({
        onboard: (provider) => { onboarded.push(provider); return 1 },
        answers: answers(),
        picks: ['expert', 'OpenRouter']
      })
      expect(code).toBe(1)
      expect(said.at(-1)).toMatch(/openrouter is not ready — mo onboard openrouter, then spore setup again/)
    })
  })

  it('stops when mohdel\'s onboarding fails, even with a refused key still stored', async () => {
    const code = await run({
      mohdel: mohdelWith({ ready: new Set(['openai']) }),
      onboard: (provider) => { onboarded.push(provider); return 1 },
      answers: { 'hold your spores\\?': join(root, 'spores') },
      picks: ['OpenAI']
    })
    expect(code).toBe(1)
    expect(said.at(-1)).toMatch(/openai has no working credential — mo onboard openai, then spore setup again/)
    expect(defaultModel().model).toBe(null)
  })

  describe('the recommended models', () => {
    const answers = () => ({ 'hold your spores\\?': join(root, 'spores'), 'tick timer': 'n' })

    it('lists their providers, ChatGPT first, the rest by label, expert last, and what is found', async () => {
      const recommended = [...RECOMMENDED, { key: 'anthropic/claude-test', version: '1.56.0' }]
      await run({ mohdel: mohdelWith({ ready: new Set(['openai', 'chatgpt']) }), mohdex: mohdexWith({ recommended }), answers: answers(), picks: [null] })
      expect(offered('which provider')).toEqual(['ChatGPT plan', 'Anthropic', 'OpenAI', 'expert'])
      expect(hints('which provider')).toEqual(['1 model recommended, signed in', '1 model recommended', '3 models recommended, key found', 'any model, any provider'])
    })

    it('offers one the catalog holds and adds nothing', async () => {
      const models = [{ model: 'openai/gpt-cheap', type: 'model', tags: [], billing: 'metered', priced: true }]
      await run({ mohdel: mohdelWith({ models }), answers: answers(), picks: ['OpenAI', 'openai/gpt-cheap'] })
      expect(added).toEqual([])
      expect(defaultModel().model).toBe('openai/gpt-cheap')
    })

    it('runs cheapest first, a tiered price by its default, naming where it rises', async () => {
      await run({ answers: answers(), picks: ['OpenAI', 'openai/gpt-cheap'] })
      expect(offered('which model')).toEqual(['openai/gpt-cheap', 'openai/gpt-tiered', 'openai/gpt-dear'])
      expect(hints('which model')).toEqual(['$0.50 / $2.00 per M', '$1.00 / $5.00 per M, more above 272k', '$4.00 / $20.00 per M'])
    })

    it('shows a plan with no price, though its entry carries one', async () => {
      await run({ answers: answers(), picks: ['ChatGPT plan', 'chatgpt/gpt-plan'] })
      expect(hints('which model')).toEqual(['your plan — not metered'])
      expect(defaultModel().model).toBe('chatgpt/gpt-plan')
    })

    it('goes to expert with a warning when mohdex cannot be reached', async () => {
      await run({ mohdex: { ...mohdexWith(), recommended: unreachable }, answers: answers(), picks: ['OpenRouter', 'openrouter/priced'] })
      expect(said.some(text => /could not reach mohdex\.dev, so setup can't say which models spore recommends \(fetch failed\)/.test(text))).toBe(true)
      expect(onboarded).toEqual(['openrouter'])
      expect(defaultModel().model).toBe('openrouter/priced')
    })

    it('goes to expert with a warning when the entries cannot be fetched', async () => {
      await run({ mohdex: { ...mohdexWith(), entries: unreachable }, answers: answers(), picks: ['OpenAI', 'OpenRouter', 'openrouter/priced'] })
      expect(said.some(text => /could not reach mohdex\.dev, so setup can't say what openai's models cost/.test(text))).toBe(true)
      expect(onboarded).toEqual(['openai', 'openrouter'])
    })

    it('goes to expert with its own warning when mohdex recommends nothing', async () => {
      await run({ mohdex: mohdexWith({ recommended: [] }), answers: answers(), picks: ['OpenRouter', 'openrouter/priced'] })
      expect(said.some(text => /mohdex\.dev recommends no model for spore right now/.test(text))).toBe(true)
      expect(onboarded).toEqual(['openrouter'])
    })

    it('leaves out a model with no entry that the catalog does not hold', async () => {
      const recommended = [...RECOMMENDED, { key: 'openai/gpt-unserved', version: '1.56.0' }]
      await run({ mohdex: mohdexWith({ recommended }), answers: answers(), picks: ['OpenAI', 'openai/gpt-cheap'] })
      expect(offered('which model')).not.toContain('openai/gpt-unserved')
    })

    it('goes to expert with a warning when the catalog refuses the entry', async () => {
      const refused = async () => { throw new Error('the catalog would reject openai/gpt-cheap: inputPrice — must be >= 0') }
      await run({ mohdex: { ...mohdexWith(), add: refused }, answers: answers(), picks: ['OpenAI', 'openai/gpt-cheap', 'OpenRouter', 'openrouter/priced'] })
      expect(said.some(text => /openai\/gpt-cheap could not go in the catalog: the catalog would reject/.test(text))).toBe(true)
      expect(defaultModel().model).toBe('openrouter/priced')
    })

    it('leaves out a provider this mohdel does not know', async () => {
      const recommended = [...RECOMMENDED, { key: 'nosuch/model', version: '1.56.0' }]
      await run({ mohdex: mohdexWith({ recommended }), answers: answers(), picks: [null] })
      expect(offered('which provider')).toEqual(['ChatGPT plan', 'OpenAI', 'expert'])
    })
  })

  describe('a model already set', () => {
    const ready = () => mohdelWith({ ready: new Set(['openai', 'openrouter']) })
    const answers = () => ({ 'hold your spores\\?': join(root, 'spores'), 'tick timer': 'n' })
    const notRecommended = () => said.filter(text => /is not among the models spore recommends/.test(text))

    it('says so in one line when it is not recommended, and goes on', async () => {
      setDefaultModel('openrouter/priced')
      expect(await run({ mohdel: ready(), answers: answers() })).toBe(0)
      expect(notRecommended()).toHaveLength(1)
    })

    it('says nothing when it is recommended under an effort', async () => {
      setDefaultModel('openai/gpt-cheap:high')
      expect(await run({ mohdel: ready(), answers: answers() })).toBe(0)
      expect(notRecommended()).toEqual([])
    })

    it('warns in one line when mohdex cannot be reached, and goes on', async () => {
      setDefaultModel('openrouter/priced')
      expect(await run({ mohdel: ready(), mohdex: { ...mohdexWith(), recommended: unreachable }, answers: answers() })).toBe(0)
      expect(said.filter(text => /could not reach mohdex\.dev, so setup can't say whether openrouter\/priced is recommended/.test(text))).toHaveLength(1)
    })
  })

  it('offers to run uncontained on a host without namespaces, and stops when that is declined', async () => {
    const processes = { area: 'machine', subject: 'processes', severity: 'problem', problem: 'every turn is refused', fix: 'allow unprivileged user namespaces' }
    expect(await run({ examine: () => ({ findings: [processes] }), answers: { uncontained: 'n' } })).toBe(1)
    expect(getKey('contain')).toEqual({ contain: null })
    expect(said.slice(-2)).toEqual(['allow unprivileged user namespaces', 'then spore setup again'])

    expect(await run({ examine: () => ({ findings: [processes] }), answers: { uncontained: 'y', 'hold your spores\\?': join(root, 'spores') }, picks: [null] })).toBe(1)
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

describe('spore setup model', () => {
  it('replaces the default with a recommended model of any provider, and checks nothing else', async () => {
    setDefaultModel('openrouter/priced')
    const examine = () => { throw new Error('examined') }
    expect(await run({ verb: setupModel, examine, picks: ['OpenAI', 'openai/gpt-cheap'] })).toBe(0)
    expect(credentialOnly).toEqual(['openai'])
    expect(added).toEqual([{ key: 'openai/gpt-cheap', entry: ENTRIES['openai/gpt-cheap'] }])
    expect(defaultModel().model).toBe('openai/gpt-cheap')
    expect(said.at(-1)).toBe('spores you already have keep their model — spore model <name> <model> moves one')
  })

  it('leaves the default as it is when the pick is left', async () => {
    setDefaultModel('openrouter/priced')
    expect(await run({ verb: setupModel, picks: [null] })).toBe(1)
    expect(defaultModel().model).toBe('openrouter/priced')
  })

  it('goes to expert with a warning when mohdex cannot be reached', async () => {
    const mohdex = { ...mohdexWith(), recommended: unreachable }
    expect(await run({ verb: setupModel, mohdex, picks: ['OpenRouter', 'openrouter/priced'] })).toBe(0)
    expect(said.some(text => /could not reach mohdex\.dev, so setup can't say which models spore recommends/.test(text))).toBe(true)
    expect(onboarded).toEqual(['openrouter'])
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
    expect(shown.message).toBe('t')
    expect(said).toEqual(['h'])
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
