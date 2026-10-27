/**
 * `spore setup`: a person's first run, as one path through what the commands already do. Each step
 * looks first and says what it found, so a second run is a check; it keeps no state of its own.
 */

import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'

import { autocomplete, cancel, confirm, intro, isCancel, log, note, outro, text } from '@clack/prompts'

import {
  checkSqlite, CONFIG_FILE, defaultModel, define, doctor, list, loadMohdelEnvironment, MO,
  modelReadiness, modelsOf, providerReadiness, readConfig, setDefaultModel, setKey
} from '@rhizogrip/spore'

import { createServices } from './services.js'
import { diagnose, renderDoctor } from './doctor.js'

const ANOTHER = 'another'

const PROVIDERS = [
  { value: 'chatgpt', label: 'ChatGPT', description: 'sign in to your ChatGPT plan — its calls are not metered' },
  { value: 'openrouter', label: 'OpenRouter', description: 'one key for many providers\' models, priced by mohdel' },
  { value: ANOTHER, label: 'another provider', description: 'mohdel\'s own setup, every provider it knows' }
]

const providerOf = (model) => model.split('/')[0]

const SHOWN = 20

const line = (label, text) => log.step(`${label.padEnd(10)}${text}`)

/** A pick from a list that words narrow, each matched in the label or the description; null when left. */
export async function pickFromList ({ title, header = [], items }) {
  const picked = await autocomplete({
    message: [title, ...header].join('\n'),
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

export const onboardWithMo = (provider) => spawnSync(process.execPath, [MO, 'onboard', ...(provider ? [provider] : [])], { stdio: 'inherit' }).status

const billingText = ({ billing, priced }) => billing === 'plan'
  ? 'your plan — not metered'
  : priced === false ? 'no prices: its calls count as $0 against cost' : billing

/**
 * Resolves with the exit code: 0 once every step is done, 1 when one stops, saying what to do
 * before running it again.
 */
export async function setup () {
  const services = createServices()
  intro('spore setup')

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
      log.warn(`${processes.fix}, then spore setup again`)
      return 1
    }
    setKey('contain', 'off')
    line('processes', 'contain off — spore config set contain on when this host gives namespaces')
  } else if (processes) {
    line('processes', processes.problem)
  } else {
    line('kernel', 'Landlock confines every turn, each in namespaces of its own')
  }

  const { home } = readConfig()
  if (home) {
    line('home', home)
  } else {
    const dir = await ask('where should your spores live?', '~/.spore')
    setKey('home', dir)
    line('home', `${readConfig().home} — spore config set home <dir> moves where new ones are made`)
  }

  const model = await chooseModel()
  if (model === null) return 1

  await tickTimer({ services })

  const diagnosed = await diagnose({ services })
  if (diagnosed.findings.length) renderDoctor(diagnosed)
  else line('checked', 'this machine, your config and your spores — nothing to fix')
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
    ['spore', 'every command']
  ].map(([command, what]) => `${command.padEnd(30)}${what}`).join('\n'), 'next')
  outro('spore setup again checks all of this')
  return 0
}

/** Where another model comes from, and how a spore is given it: said, never done, by setup. */
function otherModels (provider) {
  log.message([
    `another model: /curate in spore tui, or mo curate ${provider}, adds it to your catalog —`,
    'then spore config set model <provider>/<name> for new spores, or spore edit <spore> and add it to models:'
  ])
}

/** The default model, ready to run: the one set, or a provider set up through mohdel and one of its models picked. Null stops setup. */
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
    otherModels(providerOf(current))
    return current
  }

  const provider = await pickFromList({ title: 'the models your spores run on', header: ['mohdel calls them; a provider set up here is set up for mo as well'], items: PROVIDERS })
  if (!provider) return null
  if (provider === ANOTHER) {
    onboardWithMo(null)
    loadMohdelEnvironment()
  } else if (!(await providerReadiness(provider)).ready) {
    onboardWithMo(provider)
    loadMohdelEnvironment()
    const ready = await providerReadiness(provider)
    if (!ready.ready) {
      line('model', `${provider} is not ready — ${ready.fix}, then spore setup again`)
      return null
    }
  }

  const credentials = new Map()
  const usable = []
  for (const one of await modelsOf(provider === ANOTHER ? null : provider)) {
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
    header: ['spore model <name> <model> changes one spore\'s later'],
    items: usable.map(one => ({ value: one.model, label: one.model, description: billingText(one) }))
  })
  if (!model) return null
  const chosen = usable.find(one => one.model === model)
  setDefaultModel(model)
  line('model', `${model}, ${chosen.priced === false ? `${billingText(chosen)} — mo model instructions ${providerOf(model)} fills them` : 'ready'}`)
  log.message('new spores run on it')
  otherModels(providerOf(model))
  return model
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
  if (!await yes('a spore acts on a schedule only with the tick timer — turn it on?')) {
    line('tick', 'off — spore service define tick, then enable it, once a spore has a schedule')
    return
  }
  if (!tick.defined) services.define('tick')
  services.act('enable', 'tick')
  services.act('start', 'tick')
  line('tick', 'on — schedules fire')
}
