/**
 * The bots: for each, its token and who may talk to it, and to which spore.
 *
 * One file per bot, `telegram/<bot>.json` beside `config.json`, because a bot is a face a spore
 * shows on Telegram and each runs as a service instance of its own. The routing is in the same
 * file because a bot needs it anyway: a chat absent from it is refused. Beside `config.json` and
 * `sources.json`, for the same reason — it says who reaches what, and nothing a confined agent can
 * read may say that. The token is `${VAR}`, from the environment, never kept in the file.
 *
 * Spores keep the names a person gave them. Deriving one per chat would forbid what the routing
 * allows: two chats on one spore, a spore reached through two bots, or a chat moved to another
 * spore by editing a line. Restricting any of it is policy, and policy about chats lives above
 * spore.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { CONFIG_FILE, SporeError } from '@rhizogrip/spore'

export const BOTS_DIR = 'telegram'
const NAME = /^[a-z0-9][a-z0-9._-]*$/i
const VARIABLE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/

export const botsDir = (configFile = CONFIG_FILE) => resolve(dirname(configFile), BOTS_DIR)

export function botPath (name, configFile = CONFIG_FILE) {
  if (!NAME.test(name)) {
    throw new SporeError(`"${name}" cannot be a bot's name`, { type: 'TELEGRAM_BOT_INVALID', detail: 'letters, digits, ., - and _' })
  }
  return join(botsDir(configFile), `${name}.json`)
}

export function botNames (configFile = CONFIG_FILE) {
  const dir = botsDir(configFile)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(file => file.endsWith('.json')).map(file => basename(file, '.json')).sort()
}

function read (path) {
  if (!existsSync(path)) {
    throw new SporeError(`no ${path}`, {
      type: 'TELEGRAM_NO_BOT',
      detail: 'it names the bot\'s token and which chats may talk to it, as { "token": "${VAR}", "chats": { "<chatId>": "<spore>" } } — a bot with no chats is an open door to something that spends money' // eslint-disable-line no-template-curly-in-string
    })
  }
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new SporeError(`${path} is not readable JSON`, { type: 'TELEGRAM_BOT_INVALID', detail: err.message })
  }
  const unknown = Object.keys(raw ?? {}).filter(key => !['token', 'chats'].includes(key))
  if (unknown.length) throw new SporeError(`${path} has a field spore does not know — ${unknown.join(', ')}`, { type: 'TELEGRAM_BOT_INVALID', detail: 'a bot has a token and chats' })
  if (typeof raw.token !== 'string' || !VARIABLE.test(raw.token)) {
    throw new SporeError(`${path} has no token spore can read`, {
      type: 'TELEGRAM_BOT_INVALID',
      detail: 'token names the variable holding the token from @BotFather, as "${REVIEWER_BOT_TOKEN}", set in environment beside config.json' // eslint-disable-line no-template-curly-in-string
    })
  }
  if (typeof raw.chats !== 'object' || raw.chats === null || Array.isArray(raw.chats)) {
    throw new SporeError(`${path} has no chats`, {
      type: 'TELEGRAM_BOT_INVALID',
      detail: 'chats is { "<chatId>": "<spore>" } — {} while you learn your chat id: the log names every chat it refuses'
    })
  }
  return raw
}

/**
 * `{ "<chatId>": "<spore>" }`, or `{ "<chatId>": { "spore": "<spore>", "details": true } }` for a
 * chat shown what each call does — its command or path — rather than only what kind of call it
 * is: a Telegram message leaves the machine, so that is a choice made per chat. Read on every
 * update rather than held: adding a chat should not need a restart.
 */
function entries (path) {
  return Object.entries(read(path).chats).map(([chat, entry]) => {
    const spore = typeof entry === 'string' ? entry : entry?.spore
    const extra = typeof entry === 'object' && entry !== null ? Object.keys(entry).filter(key => !['spore', 'details'].includes(key)) : []
    if (typeof spore !== 'string' || !spore || extra.length || (typeof entry === 'object' && entry.details !== undefined && typeof entry.details !== 'boolean')) {
      throw new SporeError(`${path} maps ${chat} to something that is not a spore`, {
        type: 'TELEGRAM_BOT_INVALID',
        detail: 'each chat is a chat id against the name of a spore it may reach, or { "spore": "<name>", "details": true }'
      })
    }
    return { chat, spore, details: typeof entry === 'object' && entry.details === true }
  })
}

export function allowed (path) {
  return Object.fromEntries(entries(path).map(({ chat, spore }) => [chat, spore]))
}

/** The chats shown each call's command or path, by id. */
export function detailedChats (path) {
  return new Set(entries(path).filter(entry => entry.details).map(entry => Number(entry.chat)))
}

export const tokenVariable = (path) => VARIABLE.exec(read(path).token)[1]

export function botToken (path, env) {
  const variable = tokenVariable(path)
  if (!env[variable]) {
    throw new SporeError(`${path} wants $${variable}, which is not set`, {
      type: 'TELEGRAM_NO_TOKEN',
      detail: 'the token from @BotFather goes in environment beside config.json; it never reaches a spore'
    })
  }
  return env[variable]
}

/**
 * Every variable a bot here keeps its token in: none of them is passed to a spore's runner. A bot
 * file that cannot be read is refused rather than skipped, since its token would pass unnoticed.
 */
export const tokenVariables = (configFile = CONFIG_FILE) => botNames(configFile).map(name => tokenVariable(botPath(name, configFile)))
