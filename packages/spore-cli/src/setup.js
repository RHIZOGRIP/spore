/**
 * `spore setup`: a person's first run, as one path through what the commands already do. Each step
 * looks first and says what it found, so a second run is a check; it keeps no state of its own.
 */

import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'

import { autocomplete, cancel, confirm, intro, isCancel, log, note, outro, text } from '@clack/prompts'

import {
  addFromMohdex, checkSqlite, CONFIG_FILE, defaultModel, define, doctor, list, loadMohdelEnvironment,
  MO, modelReadiness, modelsOf, mohdexEntries, mohdexRecommended, PROVIDER_INFO, providerReadiness,
  readConfig, setDefaultModel, setKey
} from '@rhizogrip/spore'

import { createServices } from './services.js'
import { diagnose, renderDoctor } from './doctor.js'

const EXPERT = 'expert'

// The two tiers the page at mohdex.dev/spore judges on.
const BAR = ['tier:core', 'tier:identity']

const providerOf = (model) => model.split('/')[0]

const SHOWN = 20

const line = (label, text) => log.step(`${label.padEnd(10)}${text}`)

/** A pick from a list that words narrow, each matched in the label or the description; null when left. */
export async function pickFromList ({ title, header = [], items }) {
  if (header.length) log.message(header.join('\n'))
  const picked = await autocomplete({
    message: title,
    options: items.map(({ value, label, description }) => ({ value, label, hint: description })),
    maxItems: SHOWN,
    filter: (search, option) => search.toLowerCase().split(/\s+/).every(word => `${option.label} ${option.hint ?? ''}`.toLowerCase().includes(word))
  })
  return isCancel(picked) ? null : picked
}

function left () {
  cancel('left — spore setup again carries on from here')
  process.exit(130)
}

async function ask (message, defaultValue) {
  const answer = await text({ message, placeholder: defaultValue, defaultValue })
  if (isCancel(answer)) left()
  return answer.trim()
}

async function yes (message) {
  const answer = await confirm({ message, initialValue: false })
  if (isCancel(answer)) left()
  return answer
}

export const onboardWithMo = (provider, { credentialOnly = false } = {}) => spawnSync(process.execPath, [
  MO, 'onboard', ...(provider ? [provider] : []), '--caller', 'spore', ...(credentialOnly ? ['--credential-only'] : [])
], { stdio: 'inherit' }).status

const billingText = ({ billing, priced }) => billing === 'plan'
  ? 'your plan — not metered'
  : priced === false ? 'no prices: its calls count as $0 against cost' : billing

/** A price is one number, or one per context size, `{ default: 1, '>272000': 2 }`. Infinity when there is none. */
const basePrice = (price) => (typeof price === 'object' ? price?.default : price) ?? Infinity

const hasPrices = (entry) => basePrice(entry?.inputPrice) !== Infinity && basePrice(entry?.outputPrice) !== Infinity

const tierText = (price) => {
  const sizes = Object.keys(Object(price)).filter(key => key.startsWith('>')).map(key => Number(key.slice(1)))
  return sizes.length ? `, more above ${Math.round(Math.min(...sizes) / 1000)}k` : ''
}

const priceText = ({ inputPrice, outputPrice }) =>
  `$${basePrice(inputPrice).toFixed(2)} / $${basePrice(outputPrice).toFixed(2)} per M${tierText(inputPrice)}`

/**
 * Resolves with the exit code: 0 once every step is done, 1 when one stops, saying what to do
 * before running it again.
 */
export async function setup () {
  const services = createServices()

  line('node', `${process.version}, SQLite ${checkSqlite()}`)

  const found = doctor().findings
  const config = found.find(one => one.subject === CONFIG_FILE && one.severity === 'problem')
  if (config) {
    line('config', `${config.problem} — ${config.fix}`)
    return 1
  }
  const machine = found.filter(one => one.area === 'machine')
  for (const one of machine.filter(one => one.subject !== 'processes')) {
    line(one.subject, `${one.problem} — ${one.fix}`)
    if (one.severity === 'problem') return 1
  }
  const processes = machine.find(one => one.subject === 'processes')
  if (processes?.severity === 'problem') {
    line('processes', processes.problem)
    log.message('without them, a turn sees the processes and command lines of every other spore of yours —\nwhich matters only when spores of other people run as this user')
    if (!await yes('run your spores uncontained?')) {
      log.warn(`${processes.fix}\nthen spore setup again`)
      return 1
    }
    setKey('contain', 'off')
    line('processes', 'contain off — spore config set contain on when this host gives namespaces')
  } else if (processes) {
    line('processes', processes.problem)
  } else {
    line('sandbox', 'ready — each turn sees only the files it is given, and none of your other programs')
  }

  const { home } = readConfig()
  if (home) {
    line('home', home)
  } else {
    log.message('each spore is a directory of its own: what it is told to be, what was said to it, a record of\neverything it ran, and the files it works on')
    const dir = await ask('which directory should hold your spores?', '~/.spore')
    setKey('home', dir)
    line('home', `${readConfig().home} — spore config set home <dir> moves where new ones are made`)
  }

  const model = await chooseModel()
  if (model === null) return 1

  await tickTimer({ services })

  const diagnosed = await diagnose({ services })
  if (diagnosed.findings.length) {
    renderDoctor(diagnosed)
  } else {
    line('checked', 'this machine, your config and your spores — nothing to fix')
    const refused = diagnosed.boundary.filter(one => one.outcome === 'refused').length
    if (diagnosed.boundary.length) line('boundary', `a turn's commands tried ${diagnosed.boundary.length} ways out here and were refused ${refused === diagnosed.boundary.length ? 'every one' : refused} — spore doctor lists them`)
  }
  if (diagnosed.findings.some(one => one.severity === 'problem')) {
    log.warn('fix those, then spore setup again — spore doctor checks just that part')
    return 1
  }

  const names = list().workspaces.map(({ ws }) => basename(ws))
  if (names.length) {
    line('spores', names.join(', '))
  } else {
    const made = define({ ws: 'main' })
    names.push('main')
    line('made', `main, your first spore, in ${made.ws}`)
  }
  const first = names.includes('main') ? 'main' : names[0]
  note([
    [`spore tui ${first}`, `talk to ${first} in a terminal screen`],
    [`spore send ${first} "…"`, 'or send it one message; the answer is printed'],
    ['cd <project> && spore here', 'a spore that works on that project\'s files — git undoes what it changes'],
    ['spore setup model', 'another recommended model, from any provider'],
    ['spore', 'every command']
  ].map(([command, what]) => `${command.padEnd(30)}${what}`).join('\n'), 'next')
  outro('spore setup again checks all of this')
  return 0
}

/** Where another model comes from, and how a spore is given it: said, never done, by setup. */
function otherModels (provider) {
  log.message([
    'another model: spore setup model offers the recommended ones, from any provider —',
    `or /curate in spore tui, or mo curate ${provider}, adds any other ${provider} model,`,
    'then spore config set model <provider>/<name> for new spores, or spore edit <spore> and add it to models:'
  ])
}

/** One line when the model set is not among those mohdex recommends. Nothing here stops setup. */
async function sayWhenNotRecommended (current) {
  let recommended
  try {
    recommended = await mohdexRecommended({ tool: 'spore', bar: BAR })
  } catch (err) {
    log.warn(`could not reach mohdex.dev, so setup can't say whether ${current} is recommended (${err.message})`)
    return
  }
  const key = current.split(/[:@]/)[0]
  if (recommended.length && !recommended.some(one => one.key === key)) {
    line('model', `${current} is not among the models spore recommends — spore setup model offers them`)
  }
}

function settle (chosen) {
  const { model, priced } = chosen
  setDefaultModel(model)
  line('model', `${model}, ${priced === false ? `${billingText(chosen)} — mo model instructions ${providerOf(model)} fills them` : 'ready'}`)
  log.message('new spores run on it')
  otherModels(providerOf(model))
  return model
}

/** The default model, ready to run: the one set, or one of the recommended models, or any model through mohdel's own setup. Null stops setup. */
async function chooseModel () {
  loadMohdelEnvironment()
  const current = defaultModel().model
  if (current) {
    let ready = await modelReadiness(current)
    if (!ready.ready) {
      line('model', `${current} is not ready — mohdel sets it up`)
      onboardWithMo(providerOf(current))
      loadMohdelEnvironment()
      ready = await modelReadiness(current)
      if (!ready.ready) {
        line('model', `${current} is still not ready — ${ready.fix}, then spore setup again`)
        return null
      }
    }
    line('model', `${current}, ${ready.priced === false ? `${billingText(ready)} — ${ready.fix}` : 'ready'}`)
    await sayWhenNotRecommended(current)
    otherModels(providerOf(current))
    return current
  }
  return chooseRecommended()
}

/** One of the recommended models, whatever is set now: provider, credential, model. Null stops. */
async function chooseRecommended () {
  let recommended
  try {
    recommended = await mohdexRecommended({ tool: 'spore', bar: BAR })
  } catch (err) {
    log.warn(`could not reach mohdex.dev, so setup can't say which models spore recommends (${err.message}) — mohdel's own setup follows`)
    return chooseAnyModel()
  }
  // The list is live and the mohdel spore pins is not, so mohdex can name a provider this mohdel does not know.
  const keys = recommended.map(one => one.key).filter(key => PROVIDER_INFO[providerOf(key)])
  if (!keys.length) {
    log.warn('mohdex.dev recommends no model for spore right now — mohdel\'s own setup follows')
    return chooseAnyModel()
  }

  const provider = await pickProvider(keys)
  if (!provider) return null
  if (provider === EXPERT) return chooseAnyModel()

  if (onboardWithMo(provider, { credentialOnly: true }) !== 0) {
    line('model', `${provider} has no working credential — mo onboard ${provider}, then spore setup again`)
    return null
  }
  loadMohdelEnvironment()

  let entries
  try {
    entries = await mohdexEntries(provider)
  } catch (err) {
    log.warn(`could not reach mohdex.dev, so setup can't say what ${provider}'s models cost (${err.message}) — mohdel's own setup follows`)
    return chooseAnyModel()
  }
  const offers = await offersOf(keys.filter(key => providerOf(key) === provider), entries, provider)
  if (!offers.length) {
    log.warn(`mohdex.dev has no entry for ${provider}'s recommended models — mohdel's own setup follows`)
    return chooseAnyModel()
  }
  const model = await pickFromList({
    title: 'the model new spores run on',
    header: ['later, spore model <name> <model> changes the model of one spore'],
    items: offers.map(one => ({ value: one.model, label: one.model, description: one.description }))
  })
  if (!model) return null
  const chosen = offers.find(one => one.model === model)
  if (!chosen.inCatalog) {
    try {
      await addFromMohdex([{ key: model, entry: entries[model] }])
    } catch (err) {
      log.warn(`${model} could not go in the catalog: ${err.message} — mohdel's own setup follows`)
      return chooseAnyModel()
    }
  }
  return settle(chosen)
}

/** The providers of the recommended models, ChatGPT first, the rest by label, then the way to any model. */
async function pickProvider (keys) {
  const items = []
  for (const provider of new Set(keys.map(providerOf))) {
    const count = keys.filter(key => providerOf(key) === provider).length
    const { credential } = await providerReadiness(provider)
    const found = credential ? `, ${provider === 'chatgpt' ? 'signed in' : 'key found'}` : ''
    items.push({ value: provider, label: PROVIDER_INFO[provider].label, description: `${count} recommended${found}` })
  }
  items.sort((a, b) => (b.value === 'chatgpt') - (a.value === 'chatgpt') || a.label.localeCompare(b.label))
  return pickFromList({
    title: 'which provider should they come from?',
    header: ['mohdel calls the models your spores run on — a provider set up here is set up for mo as well'],
    items: [...items, { value: EXPERT, label: EXPERT, description: 'any model, any provider' }]
  })
}

/** The recommended models this setup can offer, cheapest first: each has a mohdex entry to add, or is in the catalog already. */
async function offersOf (keys, entries, provider) {
  const held = new Map((await modelsOf(provider)).map(one => [one.model, one]))
  const offers = []
  for (const key of keys.filter(one => entries[one] || held.has(one))) {
    const entry = entries[key]
    const { billing } = await modelReadiness(key)
    const inCatalog = held.has(key)
    const priced = billing === 'plan' ? null : inCatalog ? held.get(key).priced : hasPrices(entry)
    const description = billing !== 'plan' && hasPrices(entry) ? priceText(entry) : billingText({ billing, priced })
    offers.push({ model: key, billing, priced, inCatalog, entry, description })
  }
  const price = (one, field) => basePrice(one.entry?.[field])
  return offers.sort((a, b) => price(a, 'inputPrice') - price(b, 'inputPrice') || price(a, 'outputPrice') - price(b, 'outputPrice'))
}

/** Expert: mohdel's own setup, then every model of every provider with a credential. */
async function chooseAnyModel () {
  onboardWithMo(null)
  loadMohdelEnvironment()

  const credentials = new Map()
  const usable = []
  for (const one of await modelsOf(null)) {
    const named = providerOf(one.model)
    if (!credentials.has(named)) credentials.set(named, (await providerReadiness(named)).credential)
    if (credentials.get(named)) usable.push(one)
  }
  if (!usable.length) {
    line('model', 'no provider has a model ready yet — mo onboard <provider>, then spore setup again')
    return null
  }
  const model = await pickFromList({
    title: 'the model new spores run on',
    header: ['later, spore model <name> <model> changes the model of one spore'],
    items: usable.map(one => ({ value: one.model, label: one.model, description: billingText(one) }))
  })
  if (!model) return null
  return settle(usable.find(one => one.model === model))
}

/** `spore setup model`: resolves with the exit code, 0 once a recommended model is the default. */
export async function setupModel () {
  intro('spore setup model')
  loadMohdelEnvironment()
  if (await chooseRecommended() === null) return 1
  outro('spores you already have keep their model — spore model <name> <model> moves one')
  return 0
}

async function tickTimer ({ services }) {
  let tick
  try {
    tick = services.show('tick')
  } catch (err) {
    if (err.type !== 'SERVICE_NO_SYSTEMD') throw err
    line('tick', 'no systemd user session here: a schedule fires only when something runs spore tick each minute')
    return
  }
  if (tick.defined && tick.enabled) {
    line('tick', 'on — schedules fire')
    return
  }
  if (list().workspaces.length || !await yes('a spore acts on a schedule only with the tick timer — turn it on?')) {
    line('tick', 'off — spore service define tick, then enable it, once a spore has a schedule')
    return
  }
  if (!tick.defined) services.define('tick')
  services.act('enable', 'tick')
  services.act('start', 'tick')
  line('tick', 'on — schedules fire')
}
