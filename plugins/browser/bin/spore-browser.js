#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { containCheck, containing, list, loadEnvironment, readConfig, recordStarted, SERVICE_STATE_DIR, sporeSocketDir } from '@rhizogrip/spore'

import { findChromium } from '../src/chrome.js'
import { IDLE_MS } from '../src/endpoint.js'
import { ENDPOINT_FILE } from '../src/endpoint-file.js'
import { probeEndpoint } from '../src/probe.js'
import { openWindow, runningService } from '../src/open.js'
import { placesOf, runBrowsers, sporesUsing } from '../src/service.js'

const PROGRAM = 'spore-browser'
const log = (line) => console.error(`${new Date().toISOString()} ${line}`)
const refuse = (problem, hint) => {
  console.error(`${PROGRAM}: ${problem}`)
  if (hint) console.error(`  ${hint}`)
  process.exit(2)
}

const opening = process.argv[2] === 'open'
let chromium
let confined
let workspaces
let using
try {
  loadEnvironment()
  const config = readConfig()
  const named = config.plugins?.browser?.settings?.chromium
  if (!named) refuse('the browser plugin is not allowed, so it names no browser', 'spore plugin allow browser chromium=<a Chromium-based browser, as google-chrome or brave-browser>')
  chromium = findChromium(named)
  confined = containing(config)
  const host = confined && !opening && containCheck()
  if (host && !host.contained) refuse(`this host cannot contain the browsers it would run — ${host.why}`, 'spore doctor says what the host refuses; "contain": false in config.json runs them unconfined')
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

if (opening) {
  const [name, url] = process.argv.slice(3)
  if (!name) refuse('open needs the spore whose profile to open', `${PROGRAM} open <spore> [url]`)
  const spore = [...using.values()].find(one => one.name === name)
  if (!spore) refuse(`${name} does not use the browser`, 'a spore uses it once its spore.cmk says plugins: [browser]')
  if (spore.profile !== 'persistent') refuse(`${name}'s profile is ${spore.profile}, so nothing a window saves would outlive it`, 'browser.profile: persistent in its spore.cmk keeps one')
  const pid = runningService(join(SERVICE_STATE_DIR, `${PROGRAM}.json`))
  if (pid) refuse(`the service is running (pid ${pid}), and would start ${name}'s browser on the profile the window holds`, 'spore service stop browser, then open it again')
  console.log(`opening ${name}'s profile in a window: log in, then close it`)
  const { code, signal } = await openWindow({ executable: chromium.executable, root: placesOf(spore).root, url })
  console.log(`the window closed${code ? ` with code ${code}` : ''}${signal ? ` on ${signal}` : ''} — spore service start browser serves the spores again`)
  process.exit(code === 0 ? 0 : 1)
}

if (process.argv.includes('--check')) {
  console.log(`${PROGRAM} · ${chromium.executable} (${chromium.version}) · ${confined ? 'contained' : 'unconfined: "contain" is false'} · ${using.size} of ${workspaces.length} spores use the browser · ready`)
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

const service = runBrowsers({ executable: chromium.executable, confined, log })
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
log(`${PROGRAM} · ${chromium.executable} (${chromium.version}) · ${confined ? 'contained' : 'unconfined: "contain" is false in config.json'} · each spore's browser stops after ${IDLE_MS / 60000}m idle`)
