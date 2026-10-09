/**
 * The bot: its token, and for each channel it serves, the spores in it and the people who may
 * address them.
 *
 * One file per bot, `discord/<bot>.json` beside `config.json`, read on every message so a channel,
 * a spore or a person is added by editing a line. A channel absent from it is not the bot's:
 * Discord shows a bot every channel it can see, and most are none of spore's business. The token
 * is `${VAR}`, from the environment, never kept in the file.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { CONFIG_FILE, SporeError } from '@rhizogrip/spore'

export const BOTS_DIR = 'discord'
const NAME = /^[a-z0-9][a-z0-9._-]*$/i
const VARIABLE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/
const SNOWFLAKE = /^\d+$/
const SHAPE = '{ "token": "${DISCORD_BOT_TOKEN}", "channels": { "<channel id>": { "spores": ["<spore>"], "humans": ["<user id>", "role:<role id>"], "sporesTalk": false } } }' // eslint-disable-line no-template-curly-in-string

export const botsDir = (configFile = CONFIG_FILE) => resolve(dirname(configFile), BOTS_DIR)

export function botPath (name, configFile = CONFIG_FILE) {
  if (!NAME.test(name)) {
    throw new SporeError(`"${name}" cannot be a bot's name`, { type: 'DISCORD_BOT_INVALID', detail: 'letters, digits, ., - and _' })
  }
  return join(botsDir(configFile), `${name}.json`)
}

export function botNames (configFile = CONFIG_FILE) {
  const dir = botsDir(configFile)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(file => file.endsWith('.json')).map(file => basename(file, '.json')).sort()
}

const invalid = (path, problem) => new SporeError(`${path} ${problem}`, { type: 'DISCORD_BOT_INVALID', detail: `a bot is ${SHAPE}` })

function read (path) {
  if (!existsSync(path)) throw new SporeError(`no ${path}`, { type: 'DISCORD_NO_BOT', detail: `it names the bot's token and the channels it serves, as ${SHAPE}` })
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new SporeError(`${path} is not readable JSON`, { type: 'DISCORD_BOT_INVALID', detail: err.message })
  }
  const unknown = Object.keys(raw ?? {}).filter(key => !['token', 'channels', 'avatars'].includes(key))
  if (unknown.length) throw invalid(path, `has a field spore does not know — ${unknown.join(', ')}`)
  if (typeof raw.token !== 'string' || !VARIABLE.test(raw.token)) throw invalid(path, 'has no token spore can read: it names the variable holding it')
  if (typeof raw.channels !== 'object' || raw.channels === null || Array.isArray(raw.channels)) throw invalid(path, 'has no channels')
  if (raw.avatars !== undefined) {
    const avatars = typeof raw.avatars === 'object' && raw.avatars !== null && !Array.isArray(raw.avatars) ? Object.entries(raw.avatars) : null
    if (!avatars || !avatars.every(([, url]) => typeof url === 'string' && /^https:\/\/\S+$/.test(url))) {
      throw invalid(path, 'has avatars that are not { "<spore>": "https://…" }: Discord fetches each image from its address')
    }
  }
  return raw
}

/** Each spore's avatar, by name, as the address Discord fetches it from; a spore with none shows Discord's own. */
export const avatarsOf = (path) => read(path).avatars ?? {}

/** Each channel the bot serves, by id: `{ spores, humans, sporesTalk }`. */
export function channelsOf (path) {
  const channels = new Map()
  for (const [channel, entry] of Object.entries(read(path).channels)) {
    const extra = Object.keys(entry ?? {}).filter(key => !['spores', 'humans', 'sporesTalk'].includes(key))
    const names = (list) => Array.isArray(list) && list.every(item => typeof item === 'string' && item)
    if (!SNOWFLAKE.test(channel)) throw invalid(path, `names a channel "${channel}" that is not a channel id`)
    if (extra.length) throw invalid(path, `has a field channel ${channel} does not take — ${extra.join(', ')}`)
    if (!names(entry.spores) || !entry.spores.length) throw invalid(path, `has a channel ${channel} with no spores`)
    if (!names(entry.humans) || !entry.humans.every(who => SNOWFLAKE.test(who.replace(/^role:/, '')))) throw invalid(path, `has a channel ${channel} whose humans are not user ids or role:<role id>`)
    if (entry.sporesTalk !== undefined && typeof entry.sporesTalk !== 'boolean') throw invalid(path, `has a channel ${channel} whose sporesTalk is not true or false`)
    channels.set(channel, { spores: entry.spores, humans: entry.humans, sporesTalk: entry.sporesTalk === true })
  }
  return channels
}

export const tokenVariable = (path) => VARIABLE.exec(read(path).token)[1]

export function botToken (path, env) {
  const variable = tokenVariable(path)
  if (!env[variable]) {
    throw new SporeError(`${path} wants $${variable}, which is not set`, {
      type: 'DISCORD_NO_TOKEN',
      detail: 'the token from the Discord Developer Portal goes in environment beside config.json; it never reaches a spore'
    })
  }
  return env[variable]
}
