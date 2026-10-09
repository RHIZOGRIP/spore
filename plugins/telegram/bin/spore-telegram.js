#!/usr/bin/env node
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadEnvironment, recordStarted } from '@rhizogrip/spore'

import { createTelegram } from '../src/api.js'
import { allowed, botNames, botPath, botsDir, botToken } from '../src/bots.js'
import { createService } from '../src/service.js'
import { statePath } from '../src/state.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const REFUSED = 2

const log = (line) => console.error(`${new Date().toISOString()} ${line}`)

const refuse = (err, hint) => {
  console.error(`spore-telegram: ${err.message}`)
  if (err.detail) console.error(`  ${err.detail}`)
  if (hint) console.error(`  ${hint}`)
  process.exit(REFUSED)
}

const bot = process.argv.slice(2).find(arg => !arg.startsWith('--'))
if (!bot) {
  refuse(new Error('which bot?'), `spore-telegram <bot> runs ${botsDir()}/<bot>.json${botNames().length ? ` — here: ${botNames().join(', ')}` : ''}`)
}

const launched = { ...process.env }
try {
  loadEnvironment()
} catch (err) {
  refuse(err)
}

let file
let telegram
try {
  file = botPath(bot)
  allowed(file)
  telegram = createTelegram(botToken(file, process.env))
} catch (err) {
  const variable = `${bot.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_BOT_TOKEN`
  refuse(err, err.type === 'TELEGRAM_NO_BOT'
    ? `mkdir -p ${botsDir()} && echo '{"token": "$\{${variable}}", "chats": {}}' > ${file}\n  with chats {}, start the bot and message it — the log names every chat it refuses, with its id`
    : null)
}

let me
try {
  me = await telegram.me()
} catch (err) {
  refuse(err, `the token comes from @BotFather, in the variable ${file} names`)
}

const state = statePath(bot)
let service
try {
  service = createService({ telegram, botFile: file, statePath: state, env: launched, log })
} catch (err) {
  refuse(err)
}

if (process.argv.includes('--check')) {
  console.log(`spore-telegram ${bot} · @${me.username} · ${file} · state ${state} · ready`)
  process.exit(0)
}

const controller = new AbortController()
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => controller.abort())

recordStarted(`telegram@${bot}`, { root: ROOT })
log(`spore-telegram ${bot} · @${me.username} · ${file} · state ${state}`)
try {
  await service.run(controller.signal)
} catch (err) {
  if (err.type === 'TELEGRAM_CONFLICT') refuse(err, 'one bot token is read by one process — stop the other one, or remove its webhook')
  log(`stopped — ${err.message}${err.detail ? ` — ${err.detail}` : ''}`)
  process.exit(1)
}
log('stopped')
process.exit(0)
