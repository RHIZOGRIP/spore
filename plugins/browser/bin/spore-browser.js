#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { list, loadEnvironment, readConfig, recordStarted, sporeSocketDir } from '@rhizogrip/spore'

import { findChromium } from '../src/chrome.js'
import { IDLE_MS } from '../src/endpoint.js'
import { ENDPOINT_FILE } from '../src/endpoint-file.js'
import { probeEndpoint } from '../src/probe.js'
import { runBrowsers, sporesUsing } from '../src/service.js'

const PROGRAM = 'spore-browser'
const log = (line) => console.error(`${new Date().toISOString()} ${line}`)
const refuse = (problem, hint) => {
  console.error(`${PROGRAM}: ${problem}`)
  if (hint) console.error(`  ${hint}`)
  process.exit(2)
}

let chromium
let workspaces
let using
try {
  loadEnvironment()
  const named = readConfig().plugins?.browser?.settings?.chromium
  if (!named) refuse('the browser plugin is not allowed, so it names no browser', 'spore plugin allow browser chromium=<a Chromium-based browser, as google-chrome or brave-browser>')
  chromium = findChromium(named)
  workspaces = list().workspaces
  using = sporesUsing(workspaces, log)
} catch (err) {
  refuse(err.message, err.detail)
}

const addressOf = (ws) => {
  try {
    return JSON.parse(readFileSync(join(sporeSocketDir(ws), ENDPOINT_FILE), 'utf8')).url
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    return null
  }
}

if (process.argv.includes('--check')) {
  console.log(`${PROGRAM} · ${chromium.executable} (${chromium.version}) · ${using.size} of ${workspaces.length} spores use the browser · ready`)
  let crossed = 0
  const said = (name, { tried, outcome, why }) => {
    if (outcome === 'crossed') crossed++
    console.log(`  ${outcome.padEnd(8)} ${name}: ${tried}${why ? ` — ${why}` : ''}`)
  }
  for (const { ws } of workspaces) {
    const spore = using.get(ws)
    const name = spore?.name ?? basename(ws)
    const url = addressOf(ws)
    if (!spore) {
      if (url) said(name, { tried: 'find a browser address, though it does not use the plugin', outcome: 'crossed', why: join(sporeSocketDir(ws), ENDPOINT_FILE) })
      continue
    }
    if (!url) {
      console.log(`  ${'untried'.padEnd(8)} ${name}: no address yet — the service is not running, or has not served it`)
      continue
    }
    for (const one of await probeEndpoint(url)) said(name, one)
  }
  process.exit(crossed ? 1 : 0)
}

const service = runBrowsers({ executable: chromium.executable, log })
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    service.close().then(() => {
      log('stopped')
      process.exit(0)
    }, (err) => {
      log(`stopped — ${err.message}`)
      process.exit(1)
    })
  })
}

await service.ready()
recordStarted(PROGRAM, { root: resolve(dirname(fileURLToPath(import.meta.url)), '..') })
log(`${PROGRAM} · ${chromium.executable} (${chromium.version}) · each spore's browser stops after ${IDLE_MS / 60000}m idle`)
