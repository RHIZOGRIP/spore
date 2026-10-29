#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CAIRN_NAME, MAX_SOCKET_PATH, readInstance, serve, tokenVariable } from '@rhizogrip/cairn'
import { CONFIG_DIR, instanceFile, loadEnvironment, readConfig, recordStarted } from '@rhizogrip/spore'

import { findings } from '../src/check.js'

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
  members = readInstance(instance).members
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

if (process.argv.includes('--check')) {
  console.log(`${PROGRAM} ${name} · ${instance} · ${join(root, name)} · ${socket} · ready`)
  process.exit(0)
}

mkdirSync(sockets, { recursive: true, mode: 0o700 })
chmodSync(sockets, 0o700)
const db = join(root, name, 'cairn.sqlite')
mkdirSync(dirname(db), { recursive: true })

let daemon
try {
  daemon = await serve({ name, instanceFile: instance, file: db, socket, token })
} catch (err) {
  refuse(err.message, err.detail)
}
recordStarted(`cairn@${name}`, { root: resolve(dirname(fileURLToPath(import.meta.url)), '..') })
log(`${PROGRAM} ${name} · ${db} · serving ${socket}`)

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => daemon.close().then(() => {
    log('stopped')
    process.exit(0)
  }))
}
