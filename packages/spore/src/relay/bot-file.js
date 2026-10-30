/**
 * A connector's bots: one file per bot, `<kind>/<bot>.json` beside `config.json`, holding its
 * credentials as `${VAR}` and its routing — who may reach which spore. Beside `config.json` and
 * `sources.json` because it says who reaches what, and nothing a confined agent can read may say
 * that. Read on every message, so a change is an edited line.
 *
 * `spec` is the adapter's description of its file: `kind`, the `fields` it takes, which of them
 * are `credentials`, an `example` of a first file, `conversations`, the sections its routing is
 * written in, and `check(raw, path)`, if any, which refuses what the platform's own fields hold.
 * Every bot file also takes `brief`, for each conversation that does not say, and `files`, the
 * largest file it takes from a person.
 *
 * A section is `{ noun, id, says, fix, fields }`: what one of its conversations is called, the
 * pattern its id matches, why one that does not is refused (`says`, as "which is not a member
 * id") and how to find a right one (`fix`), and the fields an entry takes. `not` lists ids refused
 * though they match, each `{ id, says, fix }`, and `flags` the platform's own true-or-false fields,
 * carried into the routing. A section of conversations many people share also has `people`,
 * `{ id, says, example }`, who may address its spores — and `one` when it has one spore; an entry
 * there is `{ spores, people, … }`. Any other is a person's own conversation, its entry the spore's
 * name or `{ spore, … }`, and `called` how that person is identified, as "their member id".
 */

import { existsSync } from 'node:fs'

import { CONFIG_FILE, instanceFile, instanceNames, instancesDir, readJson } from '../library/config.js'
import { native } from '../native.js'
import { NAMES } from '../core/names.js'
import { variableOf } from '../core/variables.js'
import { SporeError } from '../observability/errors.js'

const SHOWS = ['working', 'react', 'both']
const REACTIONS = { taken: '👨‍💻', failed: '💔' }
const EVERY_BOT = ['brief', 'files', 'trace']

const typeOf = (spec, what) => `${spec.kind.toUpperCase()}_${what}`

export const botsDir = (spec, configFile = CONFIG_FILE) => instancesDir(spec.kind, configFile)

export function botPath (spec, name, configFile = CONFIG_FILE) {
  if (!NAMES.bot.pattern.test(name)) {
    throw new SporeError(`"${name}" cannot be a bot's name`, { type: typeOf(spec, 'BOT_INVALID'), detail: NAMES.bot.says })
  }
  return instanceFile(spec.kind, name, configFile)
}

export const botNames = (spec, configFile = CONFIG_FILE) => instanceNames(spec.kind, configFile)

export function readBot (spec, path) {
  if (!existsSync(path)) {
    throw new SporeError(`no ${path}`, {
      type: typeOf(spec, 'NO_BOT'),
      detail: `it names the bot's ${spec.credentials.join(' and ')} and who may reach which spore, as ${spec.example} — a bot reaching no one is refused rather than left open`
    })
  }
  const raw = readJson(path, typeOf(spec, 'BOT_INVALID'))
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SporeError(`${path} is not a bot`, { type: typeOf(spec, 'BOT_INVALID'), detail: `a bot is ${spec.example}` })
  }
  const fields = [...spec.fields, ...EVERY_BOT]
  const unknown = Object.keys(raw).filter(key => !fields.includes(key))
  if (unknown.length) {
    throw new SporeError(`${path} has a field spore does not know — ${unknown.join(', ')}`, { type: typeOf(spec, 'BOT_INVALID'), detail: `a bot has ${fields.join(', ')}, as ${spec.example}` })
  }
  if (raw.brief !== undefined && typeof raw.brief !== 'boolean') {
    throw new SporeError(`${path} has a brief that is not true or false`, { type: typeOf(spec, 'BOT_INVALID'), detail: 'brief: true keeps every conversation of the bot to its spore\'s state and answers — a person, group or channel may say otherwise' })
  }
  if (raw.files !== undefined && raw.files !== false && !(typeof raw.files === 'string' && native.sizeBytes(raw.files) > 0)) {
    throw new SporeError(`${path} has a files that is not a size or false`, { type: typeOf(spec, 'BOT_INVALID'), detail: `files is the largest file the bot takes from a person, as "10MB", ${spec.label}'s own ${spec.limits.fetch / 1024 / 1024} MB when left out — or false to take none` })
  }
  if (raw.trace !== undefined && typeof raw.trace !== 'boolean') {
    throw new SporeError(`${path} has a trace that is not true or false`, { type: typeOf(spec, 'BOT_INVALID'), detail: `trace: true writes everything ${spec.label} delivers to the service's log, as it came` })
  }
  for (const field of spec.credentials) {
    if (variableOf(raw[field]) === null) {
      throw new SporeError(`${path} has no ${field} spore can read`, {
        type: typeOf(spec, 'BOT_INVALID'),
        detail: `${field} names the variable holding it, as "\${${spec.kind.toUpperCase()}_${field.toUpperCase()}}", set in environment beside config.json; it never reaches a spore`
      })
    }
  }
  return raw
}

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const RELAY_FLAGS = ['details', 'brief', 'overhear']

function routesFrom (spec, raw, path) {
  const invalid = (problem, detail = `a bot is ${spec.example}`) => new SporeError(`${path} ${problem}`, { type: typeOf(spec, 'BOT_INVALID'), detail })
  const sections = Object.entries(spec.conversations)
  const named = sections.map(([key]) => key)
  if (sections.every(([key]) => raw[key] === undefined)) throw invalid(`has no ${named.join(' and no ')}`)
  const table = new Map()
  for (const [key, section] of sections) {
    const value = raw[key] ?? {}
    if (!isRecord(value)) throw invalid(`has ${key} that is not { "<id>": … }`)
    const { noun } = section
    const flags = [...RELAY_FLAGS, ...(section.flags ?? [])].filter(name => section.fields.includes(name))
    const checked = (id, entry) => {
      const extra = Object.keys(entry).filter(field => !section.fields.includes(field))
      if (extra.length) {
        const bots = extra.filter(field => spec.fields.includes(field))
        throw invalid(`gives ${noun} ${id} ${extra.join(', ')}, which a ${noun} does not take`, `a ${noun} takes ${section.fields.join(', ')}${bots.length ? `; ${bots.join(', ')} is the bot's, beside ${named.join(' and ')}` : ''}`)
      }
      for (const name of flags) {
        if (entry[name] !== undefined && typeof entry[name] !== 'boolean') throw invalid(`has a ${noun} ${id} whose ${name} is not true or false`)
      }
      return {
        details: entry.details === true,
        show: entry.show ?? null,
        brief: typeof entry.brief === 'boolean' ? entry.brief : null,
        overhear: entry.overhear === true,
        ...Object.fromEntries((section.flags ?? []).map(name => [name, entry[name] === true]))
      }
    }
    for (const [id, entry] of Object.entries(value)) {
      const wrong = (section.not ?? []).find(rule => rule.id.test(id)) ?? (section.id.test(id) ? null : section)
      if (wrong) throw invalid(`names "${id}" among its ${key}, ${wrong.says}`, wrong.fix)
      if (!section.people) {
        const shaped = isRecord(entry)
        const spore = shaped ? entry.spore : entry
        const read = checked(id, shaped ? entry : {})
        if (typeof spore !== 'string' || !spore) throw invalid(`maps ${noun} ${id} to something that is not a spore`, `each ${noun} is ${section.called} against the name of the spore they reach, or { "spore": "<name>", "details": true }`)
        table.set(id, { spores: [spore], ...read, people: null })
        continue
      }
      if (!isRecord(entry)) throw invalid(`has a ${noun} ${id} that is not { "spores": [...], "people": [...] }`)
      const read = checked(id, entry)
      if (!Array.isArray(entry.spores) || !entry.spores.length || !entry.spores.every(spore => typeof spore === 'string' && spore)) throw invalid(`has a ${noun} ${id} with no spores`)
      if (section.one && entry.spores.length > 1) throw invalid(`gives ${noun} ${id} ${entry.spores.length} spores`, `a bot speaks in a ${noun} as itself, so a ${noun} has one spore — a second spore there is a second bot`)
      if (!Array.isArray(entry.people) || !entry.people.every(who => who === '*' || (typeof who === 'string' && section.people.id.test(who)))) {
        throw invalid(`has a ${noun} ${id} whose people are not ${section.people.says} or *`, `people is who may address its spores — ["<${section.people.example}>", …], or ["*"] for everyone in the ${noun}, written out`)
      }
      table.set(id, { spores: entry.spores, ...read, people: entry.people })
    }
  }
  return table
}

/**
 * The routing, each conversation's `show` checked: how a turn shows itself there — `working`, the
 * `working…` message edited as it goes; `react`, a reaction on the message and the platform's
 * typing; `both` — or null where the bot file leaves it to the kind of conversation. `working` and
 * `both` need a platform that edits what the bot posted (`can.edit`); a connector that does not say
 * whether it does is refused rather than guessed at. Each
 * conversation's `brief` is its own or the bot's: a brief conversation is told its spore's state
 * and its answers, and nothing of how it runs, so it cannot also ask for `details`.
 */
export function routesOf (spec, path) {
  if (typeof spec.can.edit !== 'boolean') {
    throw new SporeError(`the ${spec.label} connector does not say whether it edits a message it posted`, { type: typeOf(spec, 'CONNECTOR_OUTDATED'), detail: `it was written before spore 1.47.0, which asks every connector for can.edit — upgrade the ${spec.label} plugin` })
  }
  const raw = readBot(spec, path)
  spec.check?.(raw, path)
  const table = routesFrom(spec, raw, path)
  for (const [conversation, routed] of table) {
    routed.brief = routed.brief ?? raw.brief === true
    if (routed.brief && routed.details) {
      throw new SporeError(`${path} gives ${conversation} both brief and details`, { type: typeOf(spec, 'BOT_INVALID'), detail: 'details shows the calls themselves, and a brief conversation is told nothing of how the spore runs — set brief: false where details is wanted' })
    }
  }
  for (const [conversation, { show }] of table) {
    if (show !== null && !SHOWS.includes(show)) {
      throw new SporeError(`${path} shows ${conversation} as "${show}"`, { type: typeOf(spec, 'BOT_INVALID'), detail: 'show is working (the working… message, edited as the turn goes), react (a reaction on the message, and typing) or both' })
    }
    if (show !== null && show !== 'working' && !spec.can.react) {
      throw new SporeError(`${path} shows ${conversation} with a reaction, and a ${spec.label} bot cannot react`, { type: typeOf(spec, 'BOT_INVALID'), detail: 'show is working there' })
    }
    if (show !== null && show !== 'react' && !spec.can.edit) {
      throw new SporeError(`${path} shows ${conversation} with a working… message, and a ${spec.label} bot cannot edit one it posted`, { type: typeOf(spec, 'BOT_INVALID'), detail: 'show is react there' })
    }
  }
  return table
}

/**
 * The bot's `react`: what is put on a message while its turn runs (`taken`, 👨‍💻 when left out) and
 * on one whose turn ended without an answer (`failed`, 💔), each an emoji the platform takes.
 */
export function reactionsOf (spec, path) {
  const { react } = readBot(spec, path)
  if (react !== undefined && (typeof react !== 'object' || react === null || Array.isArray(react) || Object.keys(react).some(key => !(key in REACTIONS)))) {
    throw new SporeError(`${path} has a react spore cannot read`, { type: typeOf(spec, 'BOT_INVALID'), detail: `react is { "taken": "<emoji>", "failed": "<emoji>" }, either left out for ${REACTIONS.taken} and ${REACTIONS.failed}` })
  }
  const chosen = { ...REACTIONS, ...react }
  const refused = Object.values(chosen).filter(emoji => typeof emoji !== 'string' || !emoji || (spec.reactions !== null && !spec.reactions.includes(emoji)))
  if (refused.length) {
    throw new SporeError(`${path} reacts with ${refused.map(String).join(' ')}, which ${spec.label} does not take`, {
      type: typeOf(spec, 'BOT_INVALID'),
      detail: spec.reactions === null ? 'a reaction is an emoji' : `${spec.label} reacts only with ${spec.reactions.join(' ')}`
    })
  }
  return chosen
}

export const traceOf = (spec, path) => readBot(spec, path).trace === true

/** The largest file, in bytes, the bot takes from a person: its `files`, never past what the platform lets it fetch, and 0 for none. */
export function filesOf (spec, path) {
  const { files } = readBot(spec, path)
  if (files === false) return 0
  return files === undefined ? spec.limits.fetch : Math.min(spec.limits.fetch, Math.floor(native.sizeBytes(files)))
}

const credentialVariable = (spec, path, field) => variableOf(readBot(spec, path)[field])

export function credentialOf (spec, path, field, env) {
  const variable = credentialVariable(spec, path, field)
  if (!env[variable]) {
    throw new SporeError(`${path} wants $${variable}, which is not set`, {
      type: typeOf(spec, `NO_${field.toUpperCase()}`),
      detail: `the bot's ${field} goes in environment beside config.json; it never reaches a spore`
    })
  }
  return env[variable]
}
