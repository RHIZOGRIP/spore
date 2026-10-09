#!/usr/bin/env node
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname } from 'node:path'

import { loadEnvironment, tick, tickReport } from '../src/index.js'
import { recordStarted } from '../src/library/service-record.js'
import { ensureOtelInitialized, shutdownOtel } from '../src/observability/tracing.js'
import { apiPath, loadApi } from '../api/config.js'
import { createApiServer } from '../api/server.js'

const REFUSED = 2
const TICK_EVERY_MS = 60_000

const log = (line) => console.error(`${new Date().toISOString()} ${line}`)

const refuse = (err, hint) => {
  console.error(`spore-api: ${err.message}`)
  if (err.detail) console.error(`  ${err.detail}`)
  if (hint) console.error(`  ${hint}`)
  process.exit(REFUSED)
}

try {
  loadEnvironment()
} catch (err) {
  refuse(err)
}

let api
try {
  api = loadApi(apiPath(), process.env)
} catch (err) {
  refuse(err)
}

const where = [api.socket, api.listen && `${api.listen.host}:${api.listen.port}`].filter(Boolean).join(' and ')
const summary = `spore-api · ${where} · ${apiPath()} · ${api.callers.map(c => c.name).join(', ')}`

if (process.argv.includes('--check')) {
  console.log(summary)
  process.exit(0)
}

/** Whether something answers on the socket: a file left by a stopped API is removed, a live one is not. */
const answers = (path) => new Promise(resolve => {
  const probe = connect(path)
  probe.on('connect', () => { probe.end(); resolve(true) })
  probe.on('error', () => resolve(false))
})

await ensureOtelInitialized()
const servers = []

if (api.socket) {
  mkdirSync(dirname(api.socket), { recursive: true, mode: 0o700 })
  if (existsSync(api.socket)) {
    if (!lstatSync(api.socket).isSocket()) refuse(new Error(`${api.socket} exists and is not a socket`), 'name another path in api.json')
    if (await answers(api.socket)) refuse(new Error(`something already answers on ${api.socket}`), 'another spore-api runs — stop it first')
    unlinkSync(api.socket)
  }
  const server = createApiServer({ api, env: process.env, log })
  await new Promise((resolve, reject) => server.once('error', reject).listen(api.socket, resolve)).catch(err => refuse(err))
  chmodSync(api.socket, 0o600)
  servers.push(server)
}
if (api.listen) {
  const server = createApiServer({ api, env: process.env, log })
  await new Promise((resolve, reject) => server.once('error', reject).listen(api.listen.port, api.listen.host, resolve))
    .catch(err => refuse(err, err.code === 'EADDRINUSE' ? `something already listens on ${api.listen.host}:${api.listen.port}` : null))
  servers.push(server)
}

recordStarted('api')
log(summary)

let ticking = null
if (process.argv.includes('--tick')) {
  const pass = () => {
    try {
      for (const line of tickReport(tick()).lines) log(`tick ${line}`)
    } catch (err) {
      log(`tick failed — ${err.detail ? `${err.message} — ${err.detail}` : err.message}`)
    }
  }
  ticking = setInterval(pass, TICK_EVERY_MS)
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    clearInterval(ticking)
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
    await shutdownOtel()
    log('stopped')
    process.exit(0)
  })
}
