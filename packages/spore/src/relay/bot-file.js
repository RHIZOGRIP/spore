/**
 * A connector's bots: one file per bot, `<kind>/<bot>.json` beside `config.json`, holding its
 * credentials as `${VAR}` and its routing — who may reach which spore. Beside `config.json` and
 * `sources.json` because it says who reaches what, and nothing a confined agent can read may say
 * that. Read on every message, so a change is an edited line.
 *
 * `spec` is the adapter's description of its file: `kind`, the `fields` it takes, which of them
 * are `credentials`, an `example` of a first file, and `routes(raw, path)`, which reads the routing
 * into conversation → `{ spores, details }` and refuses what it cannot read.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { CONFIG_FILE } from '../library/config.js'
import { SporeError } from '../observability/errors.js'

const NAME = /^[a-z0-9][a-z0-9._-]*$/i
const VARIABLE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

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
    throw new SporeError(`${path} has a field spore does not know — ${unknown.join(', ')}`, { type: typeOf(spec, 'BOT_INVALID'), detail: `a bot has ${spec.fields.join(', ')}` })
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

export const routesOf = (spec, path) => spec.routes(readBot(spec, path), path)

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
