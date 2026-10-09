#!/usr/bin/env node
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadEnvironment, recordStarted } from '@rhizogrip/spore'

import { createDiscord } from '../src/api.js'
import { botNames, botPath, botsDir, botToken, channelsOf } from '../src/bots.js'
import { createService } from '../src/service.js'
import { statePath } from '../src/state.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const REFUSED = 2

const log = (line) => console.error(`${new Date().toISOString()} ${line}`)

const refuse = (err, hint) => {
  console.error(`spore-discord: ${err.message}`)
  if (err.detail) console.error(`  ${err.detail}`)
  if (hint) console.error(`  ${hint}`)
  process.exit(REFUSED)
}

const bot = process.argv.slice(2).find(arg => !arg.startsWith('--'))
if (!bot) {
  refuse(new Error('which bot?'), `spore-discord <bot> runs ${botsDir()}/<bot>.json${botNames().length ? ` — here: ${botNames().join(', ')}` : ''}`)
}

const launched = { ...process.env }
try {
  loadEnvironment()
} catch (err) {
  refuse(err)
}

let file
let discord
try {
  file = botPath(bot)
  channelsOf(file)
  discord = createDiscord(botToken(file, process.env))
} catch (err) {
  refuse(err, err.type === 'DISCORD_NO_BOT'
    ? `mkdir -p ${botsDir()} && echo '{"token": "$\{DISCORD_BOT_TOKEN}", "channels": {}}' > ${file}`
    : null)
}

let me
try {
  me = await discord.me()
} catch (err) {
  refuse(err, `the token comes from the Discord Developer Portal, in the variable ${file} names`)
}

const state = statePath(bot)
let service
try {
  service = createService({ discord, me, botFile: file, statePath: state, env: launched, log })
} catch (err) {
  refuse(err)
}

if (process.argv.includes('--check')) {
  console.log(`spore-discord ${bot} · ${me.username} · ${file} · state ${state} · ready`)
  process.exit(0)
}

const controller = new AbortController()
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => controller.abort())

recordStarted(`discord@${bot}`, { root: ROOT })
log(`spore-discord ${bot} · ${me.username} · ${file} · state ${state}`)
try {
  await service.run(controller.signal)
} catch (err) {
  if (err.type === 'DISCORD_REFUSED') refuse(err, 'Discord refused the bot: check its token, and that the Message Content intent is on in the Developer Portal')
  log(`stopped — ${err.message}${err.detail ? ` — ${err.detail}` : ''}`)
  process.exit(1)
}
log('stopped')
process.exit(0)
