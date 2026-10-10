/**
 * `spore setup`: a person's first run, as one path through what the commands already do. Each step
 * looks first and says what it found, so a second run is a check; it keeps no state of its own.
 */

import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'
import { createInterface } from 'node:readline/promises'

import {
  checkSqlite, CONFIG_FILE, defaultModel, define, doctor, list, loadMohdelEnvironment, MO,
  modelReadiness, modelsOf, providerReadiness, readConfig, setDefaultModel, setKey, settings
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

/**
 * A pick from a numbered list on the plain terminal, so setup runs where the screen is not installed:
 * a number picks, words narrow the list, empty leaves it. The value picked, or null when left.
 */
export async function pickFromList ({ title, header = [], items }, { prompt = ask, say = console.log } = {}) {
  say('')
  say(title)
  for (const line of header) say(`  ${line}`)
  let shown = items
  while (true) {
    const width = String(Math.min(shown.length, SHOWN)).length
    shown.slice(0, SHOWN).forEach((item, i) => say(`  ${String(i + 1).padStart(width)}  ${item.label}${item.description ? ` — ${item.description}` : ''}`))
    if (shown.length > SHOWN) say(`  … and ${shown.length - SHOWN} more — words narrow the list`)
    const answer = await prompt('a number, or words to narrow the list — empty to leave:')
    if (!answer) return null
    if (/^\d+$/.test(answer)) {
      const chosen = shown.slice(0, SHOWN)[Number(answer) - 1]
      if (chosen) return chosen.value
      say(`  ${answer} is not in the list`)
      continue
    }
    const words = answer.toLowerCase().split(/\s+/)
    const narrowed = items.filter(item => words.every(word => `${item.label} ${item.description ?? ''}`.toLowerCase().includes(word)))
    if (narrowed.length) shown = narrowed
    else say(`  nothing matches ${answer}`)
  }
}

export async function ask (question, preset = '') {
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  prompt.on('SIGINT', () => process.exit(130))
  try {
    return (await prompt.question(preset ? `${question} [${preset}] ` : `${question} `)).trim() || preset
  } finally {
    prompt.close()
  }
}

export const onboardWithMo = (provider) => spawnSync(process.execPath, [MO, 'onboard', ...(provider ? [provider] : [])], { stdio: 'inherit' }).status

const readings = { loadKeys: loadMohdelEnvironment, modelReadiness, modelsOf, providerReadiness }

const billingText = ({ billing, priced }) => billing === 'plan'
  ? 'your plan — not metered'
  : priced === false ? 'no prices: its calls count as $0 against cost and spend limits' : billing

/**
 * Resolves with the exit code: 0 once every step is done, 1 when one stops, saying what to do
 * before running it again.
 */
export async function setup ({
  say = console.log,
  prompt = ask,
  pick = (menu) => pickFromList(menu, { prompt, say }),
  onboard = onboardWithMo,
  mohdel = readings,
  services = createServices(),
  examine = doctor,
  report = diagnose,
  sqlite = checkSqlite
} = {}) {
  const yes = async (question) => /^y(es)?$/i.test(await prompt(`${question} [y/N]`))
  const line = (label, text) => say(`${label.padEnd(10)}${text}`)

  line('node', `${process.version}, SQLite ${sqlite()}`)

  const found = examine().findings
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
    say(`${''.padEnd(10)}without them, a turn sees the processes and command lines of every other spore of yours —\n${''.padEnd(10)}which matters only when spores of other people run as this user`)
    if (!await yes('run your spores uncontained?')) {
      say(`${''.padEnd(10)}${processes.fix}, then spore setup again`)
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
    const dir = await prompt('where should your spores live?', '~/.spore')
    setKey('home', dir)
    line('home', `${readConfig().home} — spore config set home <dir> moves where new ones are made`)
  }

  const model = await chooseModel({ line, say, pick, onboard, mohdel })
  if (model === null) return 1

  const spend = settings().find(row => row.key === 'spendPerDay')
  if (spend.from === 'set') {
    line('spend', `at most $${spend.value} a day`)
  } else {
    const dollars = await prompt('a daily spend limit for your spores, in dollars — empty for none:')
    if (dollars) setKey('spendPerDay', dollars)
    line('spend', dollars ? `at most $${dollars} a day` : 'no daily limit — spore config set spendPerDay <dollars> sets one')
  }

  await tickTimer({ line, yes, services })

  say('')
  const diagnosed = await report({ services })
  if (diagnosed.findings.length) renderDoctor(diagnosed)
  else line('checked', 'this machine, your config and your spores — nothing to fix')
  say('')
  if (diagnosed.findings.some(one => one.severity === 'problem')) {
    say('fix those, then spore setup again — spore doctor checks just that part')
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
  say('')
  say('next')
  for (const [command, what] of [
    [`spore tui ${first}`, `talk to ${first} in a terminal screen`],
    [`spore send ${first} "…"`, 'or send it one message; the answer is printed'],
    ['cd <project> && spore here', 'a spore that works on that project\'s files — git undoes what it changes'],
    ['spore', 'every command']
  ]) say(`  ${command.padEnd(30)}${what}`)
  return 0
}

/** Where another model comes from, and how a spore is given it: said, never done, by setup. */
function otherModels (say, provider) {
  const pad = ''.padEnd(10)
  say(`${pad}another model: /curate in spore tui, or mo curate ${provider}, adds it to your catalog —`)
  say(`${pad}then spore config set model <provider>/<name> for new spores, or spore edit <spore> and add it to models:`)
}

/** The default model, ready to run: the one set, or a provider set up through mohdel and one of its models picked. Null stops setup. */
async function chooseModel ({ line, say, pick, onboard, mohdel }) {
  mohdel.loadKeys()
  const current = defaultModel().model
  if (current) {
    let ready = await mohdel.modelReadiness(current)
    if (!ready.ready) {
      line('model', `${current} is not ready — mohdel sets it up`)
      onboard(providerOf(current))
      mohdel.loadKeys()
      ready = await mohdel.modelReadiness(current)
      if (!ready.ready) {
        line('model', `${current} is still not ready — ${ready.fix}, then spore setup again`)
        return null
      }
    }
    line('model', `${current}, ${ready.priced === false ? `${billingText(ready)} — ${ready.fix}` : 'ready'}`)
    otherModels(say, providerOf(current))
    return current
  }

  const provider = await pick({ title: 'the models your spores run on', header: ['mohdel calls them; a provider set up here is set up for mo as well'], items: PROVIDERS })
  if (!provider) return null
  if (provider === ANOTHER) {
    onboard(null)
    mohdel.loadKeys()
  } else if (!(await mohdel.providerReadiness(provider)).ready) {
    onboard(provider)
    mohdel.loadKeys()
    const ready = await mohdel.providerReadiness(provider)
    if (!ready.ready) {
      line('model', `${provider} is not ready — ${ready.fix}, then spore setup again`)
      return null
    }
  }

  const credentials = new Map()
  const usable = []
  for (const one of await mohdel.modelsOf(provider === ANOTHER ? null : provider)) {
    const named = providerOf(one.model)
    if (!credentials.has(named)) credentials.set(named, (await mohdel.providerReadiness(named)).credential)
    if (credentials.get(named)) usable.push(one)
  }
  if (!usable.length) {
    line('model', 'no provider has a model ready yet — mo onboard <provider>, then spore setup again')
    return null
  }
  const model = await pick({
    title: 'the model new spores run on',
    header: ['spore model <name> <model> changes one spore\'s later'],
    items: usable.map(one => ({ value: one.model, label: one.model, description: billingText(one) }))
  })
  if (!model) return null
  const chosen = usable.find(one => one.model === model)
  setDefaultModel(model)
  line('model', `${model}, ${chosen.priced === false ? `${billingText(chosen)} — mo model instructions ${providerOf(model)} fills them` : 'ready'}`)
  say(`${''.padEnd(10)}new spores run on it`)
  otherModels(say, providerOf(model))
  return model
}

async function tickTimer ({ line, yes, services }) {
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
