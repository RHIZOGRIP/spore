import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { CONFIG_FILE, definitionPath, list, parseDefinition, sporeSocketDir, TOOL_NAMES } from '@rhizogrip/spore'

import { startChrome } from './chrome.js'
import { openEndpoint } from './endpoint.js'
import { ENDPOINT_FILE } from './endpoint-file.js'

export const PLUGIN = 'browser'
const RESCAN_MS = 500

const MANIFEST = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).spore
const PROFILES = MANIFEST.options.profile.values
const DEFAULT_PROFILE = MANIFEST.options.profile.default

const stateHome = (env) => env.XDG_STATE_HOME || join(homedir(), '.local', 'state')

/**
 * Every spore whose definition uses the plugin, with the profile it chose: read from the
 * operator's `spore.cmk` files, the root of which the agent cannot write, and nothing else of
 * a spore. One the runtime would refuse a turn to is left out, and said.
 */
export function sporesUsing (workspaces, log) {
  const found = new Map()
  const names = new Map()
  for (const { ws } of workspaces) {
    let source
    try {
      source = readFileSync(definitionPath(ws), 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') continue
      throw err
    }
    const definition = parseDefinition(source, { knownTools: TOOL_NAMES })
    if (definition.error || !definition.plugins.includes(PLUGIN)) continue
    const name = basename(ws)
    const profile = definition.pluginOptions[PLUGIN]?.profile ?? DEFAULT_PROFILE
    if (!PROFILES.includes(profile)) {
      log(`${name}: browser.profile is ${profile}, which it cannot be — not served`)
      continue
    }
    if (names.has(name)) {
      log(`${name}: ${ws} and ${names.get(name)} are both called ${name}, and a profile is kept by name — ${ws} not served`)
      continue
    }
    names.set(name, ws)
    found.set(ws, { ws, name, profile })
  }
  return found
}

/**
 * Where a spore's browser keeps what it keeps. The scratch directory, beside the spores' socket
 * directories, holds Chrome's `TMPDIR` — short, for the lock socket Chrome makes there, and
 * written by no agent — and an ephemeral profile. A persistent one is under the state home.
 */
export function placesOf (spore, env = process.env) {
  const sockets = sporeSocketDir(spore.ws)
  const scratch = join(dirname(sockets), PLUGIN, basename(sockets))
  const root = spore.profile === 'persistent' ? join(stateHome(env), 'spore', PLUGIN, spore.name) : join(scratch, 'ephemeral')
  return { sockets, scratch, tmp: join(scratch, 'tmp'), root }
}

/**
 * The endpoint's address, where only the spore's agent reads it. The agent writes that directory
 * too, so the file is made under a name nobody could have prepared and renamed into place: an
 * exclusive create refuses a link left there, and a rename replaces a link rather than following it.
 */
function writeEndpoint (sockets, url) {
  const file = join(sockets, ENDPOINT_FILE)
  const fresh = `${file}.${randomBytes(8).toString('hex')}`
  writeFileSync(fresh, JSON.stringify({ url }) + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(fresh, file)
}

async function serve (spore, { executable, log }) {
  const places = placesOf(spore)
  const said = (line) => log(`${spore.name}: ${line}`)
  const ephemeral = spore.profile !== 'persistent'
  const clear = async () => {
    rmSync(places.tmp, { recursive: true, force: true })
    if (ephemeral) rmSync(places.root, { recursive: true, force: true })
  }
  await clear()
  const endpoint = await openEndpoint({
    data: join(spore.ws, 'data'),
    log: said,
    stopped: clear,
    launch: async ({ onExit }) => {
      await clear()
      mkdirSync(places.tmp, { recursive: true, mode: 0o700 })
      for (const dir of ['profile', 'home', 'cache']) mkdirSync(join(places.root, dir), { recursive: true, mode: 0o700 })
      return startChrome({ executable, profile: join(places.root, 'profile'), cache: join(places.root, 'cache'), home: join(places.root, 'home'), tmp: places.tmp, onExit })
    }
  })
  writeEndpoint(places.sockets, endpoint.url)
  said(`served, ${spore.profile} profile${ephemeral ? '' : ` at ${places.root}`}`)
  return {
    ...spore,
    async close () {
      rmSync(join(places.sockets, ENDPOINT_FILE), { force: true })
      await endpoint.close()
      rmSync(places.scratch, { recursive: true, force: true })
    }
  }
}

/**
 * Serves every spore that uses the plugin, and follows the definitions: a spore that starts using
 * it is served, one that stops or changes its profile has its browser stopped first.
 */
export function runBrowsers ({ executable, log }) {
  const served = new Map()
  const watchers = new Map()
  let queue = Promise.resolve()
  let timer = null
  let closing = false

  const rescanSoon = () => {
    if (closing) return
    clearTimeout(timer)
    timer = setTimeout(() => { queue = queue.then(reconcile) }, RESCAN_MS)
  }

  const watchDir = (dir, relevant) => {
    if (watchers.has(dir)) return
    try {
      const watcher = watch(dir, (_, file) => { if (relevant(file)) rescanSoon() })
      watcher.on('error', () => {
        watchers.delete(dir)
        rescanSoon()
      })
      watchers.set(dir, watcher)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      log(`not following ${dir}, which is not there`)
    }
  }

  async function reconcile () {
    if (closing) return
    let home, workspaces, wanted
    try {
      ({ home, workspaces } = list())
      wanted = sporesUsing(workspaces, log)
    } catch (err) {
      log(`could not read the spores — ${err.message}`)
      return
    }
    for (const [ws, one] of served) {
      const still = wanted.get(ws)
      if (still && still.profile === one.profile) continue
      served.delete(ws)
      await one.close()
      log(`${one.name}: ${still ? `profile now ${still.profile}` : 'no longer uses the browser'} — its browser stopped`)
    }
    for (const [ws, spore] of wanted) {
      if (served.has(ws)) continue
      try {
        served.set(ws, await serve(spore, { executable, log }))
      } catch (err) {
        log(`${spore.name}: not served — ${err.message}${err.detail ? ` (${err.detail})` : ''}`)
      }
    }
    const following = new Set([home, dirname(CONFIG_FILE), ...workspaces.map(w => w.ws)])
    for (const [dir, watcher] of watchers) {
      if (following.has(dir)) continue
      watcher.close()
      watchers.delete(dir)
    }
    watchDir(home, () => true)
    watchDir(dirname(CONFIG_FILE), file => file === basename(CONFIG_FILE))
    for (const { ws } of workspaces) watchDir(ws, file => file === 'spore.cmk')
  }

  queue = queue.then(reconcile)
  return {
    ready: () => queue,
    async close () {
      closing = true
      clearTimeout(timer)
      await queue
      for (const watcher of watchers.values()) watcher.close()
      for (const one of served.values()) await one.close()
      served.clear()
    }
  }
}
