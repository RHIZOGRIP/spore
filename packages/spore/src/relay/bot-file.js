/**
 * A connector's bots: one file per bot, `<kind>/<bot>.json` beside `config.json`, holding its
 * credentials as `${VAR}` and its routing — who may reach which spore. Beside `config.json` and
 * `sources.json` because it says who reaches what, and nothing a confined agent can read may say
 * that. Read on every message, so a change is an edited line.
 *
 * `spec` is the adapter's description of its file: `kind`, the `fields` it takes, which of them
 * are `credentials`, an `example` of a first file, and `routes(raw, path)`, which reads the routing
 * into conversation → `{ spores, details, show, brief, people, overhear }` and refuses what it
 * cannot read — `brief` null where the entry leaves it to the bot's. Every bot file also takes
 * `brief`, for each conversation that does not say, and `files`, the largest file it takes from a
 * person.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { CONFIG_FILE } from '../library/config.js'
import { native } from '../native.js'
import { NAMES } from '../core/names.js'
import { variableOf } from '../core/variables.js'
import { SporeError } from '../observability/errors.js'

const SHOWS = ['working', 'react', 'both']
const REACTIONS = { taken: '👨‍💻', failed: '💔' }
const EVERY_BOT = ['brief', 'files']

const typeOf = (spec, what) => `${spec.kind.toUpperCase()}_${what}`

export const botsDir = (spec, configFile = CONFIG_FILE) => resolve(dirname(configFile), spec.kind)

export function botPath (spec, name, configFile = CONFIG_FILE) {
  if (!NAMES.bot.pattern.test(name)) {
    throw new SporeError(`"${name}" cannot be a bot's name`, { type: typeOf(spec, 'BOT_INVALID'), detail: NAMES.bot.says })
  }
  return join(botsDir(spec, configFile), `${name}.json`)
}

export function botNames (spec, configFile = CONFIG_FILE) {
  const dir = botsDir(spec, configFile)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(file => file.endsWith('.json')).map(file => basename(file, '.json')).sort()
}

export function readBot (spec, path) {
  if (!existsSync(path)) {
    throw new SporeError(`no ${path}`, {
      type: typeOf(spec, 'NO_BOT'),
      detail: `it names the bot's ${spec.credentials.join(' and ')} and who may reach which spore, as ${spec.example} — a bot reaching no one is refused rather than left open`
    })
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new SporeError(`${path} is not readable JSON`, { type: typeOf(spec, 'BOT_INVALID'), detail: err.message })
  }
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

/**
 * The routing, each conversation's `show` checked: how a turn shows itself there — `working`, the
 * `working…` message edited as it goes; `react`, a reaction on the message and the platform's
 * typing; `both` — or null where the bot file leaves it to the kind of conversation. Each
 * conversation's `brief` is its own or the bot's: a brief conversation is told its spore's state
 * and its answers, and nothing of how it runs, so it cannot also ask for `details`.
 */
export function routesOf (spec, path) {
  const raw = readBot(spec, path)
  const table = spec.routes(raw, path)
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

/** The largest file, in bytes, the bot takes from a person: its `files`, never past what the platform lets it fetch, and 0 for none. */
export function filesOf (spec, path) {
  const { files } = readBot(spec, path)
  if (files === false) return 0
  return files === undefined ? spec.limits.fetch : Math.min(spec.limits.fetch, Math.floor(native.sizeBytes(files)))
}

export const credentialVariable = (spec, path, field) => variableOf(readBot(spec, path)[field])

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

/**
 * Every variable a bot of this kind keeps a credential in: none reaches a spore's runner unless
 * a source of the plugin's own needs it. A bot file that cannot be read is refused rather than
 * skipped, since its credential would pass unnoticed.
 */
export const credentialVariables = (spec, configFile = CONFIG_FILE) =>
  botNames(spec, configFile).flatMap(name => spec.credentials.map(field => credentialVariable(spec, botPath(spec, name, configFile), field)))
