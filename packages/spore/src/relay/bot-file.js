/**
 * A connector's bots: one file per bot, `<kind>/<bot>.json` beside `config.json`, holding its
 * credentials as `${VAR}` and its routing — who may reach which spore. Beside `config.json` and
 * `sources.json` because it says who reaches what, and nothing a confined agent can read may say
 * that. Read on every message, so a change is an edited line.
 *
 * `spec` is the adapter's description of its file: `kind`, the `fields` it takes, which of them
 * are `credentials`, an `example` of a first file, and `routes(raw, path)`, which reads the routing
 * into conversation → `{ spores, details, show, people, overhear }` and refuses what it cannot read.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { CONFIG_FILE } from '../library/config.js'
import { SporeError } from '../observability/errors.js'

const NAME = /^[a-z0-9][a-z0-9._-]*$/i
const VARIABLE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/
const SHOWS = ['working', 'react', 'both']
const REACTIONS = { taken: '👨‍💻', failed: '💔' }

const typeOf = (spec, what) => `${spec.kind.toUpperCase()}_${what}`

export const botsDir = (spec, configFile = CONFIG_FILE) => resolve(dirname(configFile), spec.kind)

export function botPath (spec, name, configFile = CONFIG_FILE) {
  if (!NAME.test(name)) {
    throw new SporeError(`"${name}" cannot be a bot's name`, { type: typeOf(spec, 'BOT_INVALID'), detail: 'letters, digits, ., - and _' })
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
  const unknown = Object.keys(raw).filter(key => !spec.fields.includes(key))
  if (unknown.length) {
    throw new SporeError(`${path} has a field spore does not know — ${unknown.join(', ')}`, { type: typeOf(spec, 'BOT_INVALID'), detail: `a bot has ${spec.fields.join(', ')}, as ${spec.example}` })
  }
  for (const field of spec.credentials) {
    if (typeof raw[field] !== 'string' || !VARIABLE.test(raw[field])) {
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
 * typing; `both` — or null where the bot file leaves it to the kind of conversation.
 */
export function routesOf (spec, path) {
  const table = spec.routes(readBot(spec, path), path)
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

export const credentialVariable = (spec, path, field) => VARIABLE.exec(readBot(spec, path)[field])[1]

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
