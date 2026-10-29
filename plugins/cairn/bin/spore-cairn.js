#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CAIRN_NAME, MAX_SOCKET_PATH, readInstance, serve, tokenVariable } from '@rhizogrip/cairn'
import { apiCaller, CONFIG_DIR, instanceFile, loadEnvironment, readConfig, recordStarted } from '@rhizogrip/spore'
import { statePath } from '@rhizogrip/spore/relay'

import { findings } from '../src/check.js'
import { startNotifier } from '../src/notifier.js'

const PROGRAM = 'spore-cairn'
const log = (line) => console.error(`${new Date().toISOString()} ${line}`)
const refuse = (problem, hint) => {
  console.error(`${PROGRAM}: ${problem}`)
  if (hint) console.error(`  ${hint}`)
  process.exit(2)
}

const name = process.argv.slice(2).find(arg => !arg.startsWith('--'))
if (!name) refuse('which cairn?', `${PROGRAM} <cairn> serves the cairn ${instanceFile('cairn', '<cairn>')} describes`)
if (!CAIRN_NAME.test(name)) refuse(`"${name}" cannot be a cairn's name`, 'lowercase letters, digits and -')

try {
  loadEnvironment()
} catch (err) {
  refuse(err.message, err.detail)
}

let root
let members
let notify
try {
  root = readConfig().plugins?.cairn?.settings?.root
} catch (err) {
  refuse(err.message, err.detail)
}
if (!root) refuse('the cairn plugin has no root', 'spore plugin allow cairn root=<a directory>')
if (!isAbsolute(root) || normalize(root) !== root || root.endsWith('/')) refuse(`root is ${root}, and it is an absolute path written plainly`, 'spore plugin allow cairn root=<a directory>')

const instance = instanceFile('cairn', name)
if (!existsSync(instance)) refuse(`there is no ${instance}`, `mkdir -p ${dirname(instance)} — then ${instance} as { "members": { "<spore>": "<role>" }, "kinds": {}, "subjects": {} }`)
try {
  ({ members, notify } = readInstance(instance))
} catch (err) {
  refuse(err.message)
}

const variable = tokenVariable(name)
const token = process.env[variable]
if (!token) refuse(`${variable} is not set`, `add it to ${join(CONFIG_DIR, 'environment')}, where the sources.json entry for this cairn reads it too`)

const sockets = join(root, 'sockets')
const socket = join(sockets, `${name}.sock`)
if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) refuse(`${socket} is longer than a unix socket path may be (${MAX_SOCKET_PATH} bytes)`, 'choose a shorter root')

try {
  for (const finding of findings({ name, root, members, socket })) log(`warning: ${finding}`)
} catch (err) {
  refuse(err.message, err.detail)
}

let caller = null
if (notify) {
  try {
    caller = apiCaller(`cairn-${name}`)
  } catch (err) {
    refuse(`${name} wakes its members through the HTTP API, as the caller cairn-${name}: ${err.message}`, err.detail)
  }
}

if (process.argv.includes('--check')) {
  console.log(`${PROGRAM} ${name} · ${instance} · ${join(root, name)} · ${socket}${caller ? ` · notices through ${caller.socket ?? caller.listen.text}` : ''} · ready`)
  process.exit(0)
}

mkdirSync(sockets, { recursive: true, mode: 0o700 })
chmodSync(sockets, 0o700)
const db = join(root, name, 'cairn.sqlite')
mkdirSync(dirname(db), { recursive: true })

let daemon
let notifier = null
try {
  daemon = await serve({ name, instanceFile: instance, file: db, socket, token, appended: () => notifier?.wake() })
} catch (err) {
  refuse(err.message, err.detail)
}
if (caller) {
  try {
    notifier = startNotifier({ name, file: db, members, notify, caller, statePath: statePath('cairn', name), log })
  } catch (err) {
    await daemon.close()
    refuse(err.message, err.detail)
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    notifier?.stop()
    daemon.close().then(() => {
      log('stopped')
      process.exit(0)
    }, (err) => {
      log(`stopped — ${err.message}`)
      process.exit(1)
    })
  })
}

recordStarted(`cairn@${name}`, { root: resolve(dirname(fileURLToPath(import.meta.url)), '..') })
log(`${PROGRAM} ${name} · ${db} · serving ${socket}`)
