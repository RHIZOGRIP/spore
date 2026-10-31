/**
 * Where workspaces live, and how many turns may run at once.
 *
 * Two path fields, holding two different kinds of thing. `home` is a directory that contains
 * workspaces and is not one itself; new spores are made in it, which is why it is a single
 * path. `workspaces` names individual workspaces that live somewhere else — the exception
 * to the rule that a spore is in `home`, which is why it is a list.
 *
 * The file does not name what is running, what anything cost, or what anything is called.
 * All of that is read from the directories themselves, because a file recording liveness
 * is wrong the moment something crashes while a search path cannot go stale.
 *
 * Host side only. `sandbox()` deliberately does not grant `~/.config`, so nothing a
 * confined agent can reach may read this: a spore has no business discovering the
 * workspaces beside it.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, resolve, join } from 'node:path'

import { isWorkspace, sporesInHome } from './discover.js'
import { native } from '../native.js'
import { NAMES } from '../core/names.js'
import { durationSpelling, sizeSpelling } from '../core/units.js'
import { variableOf } from '../core/variables.js'
import { SporeError } from '../observability/errors.js'

export const CONFIG_DIR = process.env.XDG_CONFIG_HOME
  ? join(process.env.XDG_CONFIG_HOME, 'spore')
  : join(homedir(), '.config', 'spore')

export const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

/** The folder beside `configFile` holding a service's instances, `<instance>.json` each: a connector's bots. */
export const instancesDir = (service, configFile = CONFIG_FILE) => resolve(dirname(configFile), service)

export const instanceFile = (service, instance, configFile = CONFIG_FILE) => join(instancesDir(service, configFile), `${instance}.json`)

export function instanceNames (service, configFile = CONFIG_FILE) {
  const dir = instancesDir(service, configFile)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(file => file.endsWith('.json')).map(file => file.slice(0, -'.json'.length)).sort()
}

/**
 * What a source name means, host-side, beside `config.json`. It holds credentials, so the
 * runner reads it and nothing a confined agent reaches may.
 */
export const SOURCES_FILE = 'sources.json'

/** Where the vector store of `memory: vectors` is, host-side, beside `config.json`; it holds its credential like `sources.json`. */
export const MEMORY_FILE = 'memory.json'

export const HOOKS_FILE = 'hooks.json'
export const API_FILE = 'api.json'

/**
 * The process environment the operator keeps for spore, beside `config.json`: provider keys,
 * `PATH`, the Telegram bots' tokens. Read by the commands, never by the library, whose callers pass
 * their own `env`.
 */
export const ENVIRONMENT_FILE = 'environment'

const expand = (path) => (path.startsWith('~') ? join(homedir(), path.slice(1)) : resolve(path))

/** What an operator's JSON file at `path` holds; one that does not parse is refused as `type`. */
export function readJson (path, type) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new SporeError(`${path} is not readable JSON`, { type, detail: err.message })
  }
}

export function readConfig (file = CONFIG_FILE) {
  if (!existsSync(file)) return { home: null, workspaces: [], file, exists: false }

  const raw = readJson(file, 'CONFIG_UNREADABLE')
  validate(raw, file)
  const home = raw.home ? expand(raw.home) : null
  if (home) checkLayout(home, raw.homeSplit ?? null, file)
  return {
    ...raw,
    home,
    ...(raw.gate ? { gate: expand(raw.gate) } : {}),
    workspaces: (raw.workspaces || []).map(expand),
    file,
    exists: true
  }
}

export const ENVIRONMENT_LINE = 'one variable per line, as systemd reads it — no export, no spaces around ='

/** Each line of an environment file that says something: `{ line, key, value }`, or `{ line }` for one that is not KEY=value. */
export function environmentLines (text) {
  return text.split('\n').flatMap((raw, i) => {
    const text = raw.trim()
    if (!text || text.startsWith('#') || text.startsWith(';')) return []
    const at = text.indexOf('=')
    const key = text.slice(0, at)
    return at > 0 && NAMES.variable.pattern.test(key) ? [{ line: i + 1, key, value: text.slice(at + 1) }] : [{ line: i + 1 }]
  })
}

/**
 * Sets what `environment` names and the process does not already have: a variable set by
 * whoever started the command wins over the file. The format is the one systemd's
 * `EnvironmentFile=` reads, so one file serves both — `KEY=value` lines, `#` and `;`
 * comments, a value optionally quoted, nothing expanded. A missing file is no environment.
 *
 * @returns {{ path: string, loaded: string[] }}
 */
export function loadEnvironment (file = CONFIG_FILE, env = process.env) {
  const path = resolve(dirname(file), ENVIRONMENT_FILE)
  const loaded = []
  if (!existsSync(path)) return { path, loaded }
  for (const { line, key, value: raw } of environmentLines(readFileSync(path, 'utf8'))) {
    if (key === undefined) {
      throw new SporeError(`${path}:${line} is not KEY=value`, {
        type: 'ENVIRONMENT_INVALID',
        detail: ENVIRONMENT_LINE
      })
    }
    const quoted = /^(["'])(.*)\1$/.exec(raw)
    if (env[key] !== undefined) continue
    env[key] = quoted ? quoted[2] : raw
    loaded.push(key)
  }
  return { path, loaded }
}

function validate (raw, file) {
  const known = [...KEYS, 'plugins', 'replyTo', 'approvals']
  const unknown = isRecord(raw) ? Object.keys(raw).filter(key => !known.includes(key)) : []
  if (!isRecord(raw) || unknown.length) {
    throw new SporeError(isRecord(raw) ? `${file} has ${unknown.join(', ')}, which spore does not read` : `${file} is not a JSON object`, {
      type: 'CONFIG_INVALID',
      detail: `it takes ${known.join(', ')} — remove anything else`
    })
  }
  if (raw.workspaces !== undefined && !Array.isArray(raw.workspaces)) {
    throw new SporeError(`${file} has a workspaces that is not a list`, {
      type: 'CONFIG_INVALID',
      detail: 'workspaces names the ones living outside home, as an array of paths'
    })
  }
  if (raw.home !== undefined && typeof raw.home !== 'string') {
    throw new SporeError(`${file} has a home that is not a path`, {
      type: 'CONFIG_INVALID',
      detail: 'home is the one directory workspaces are made in, as a single path'
    })
  }
  if (raw.gate !== undefined && typeof raw.gate !== 'string') {
    throw new SporeError(`${file} has a gate that is not a path`, {
      type: 'CONFIG_INVALID',
      detail: 'gate is the data socket of the mohdel gate every turn calls its models through, as a single path'
    })
  }
  if (raw.admission !== undefined && !ADMISSIONS.includes(raw.admission)) {
    throw new SporeError(`${file} has an admission that is not spore or caller`, {
      type: 'CONFIG_INVALID',
      detail: ADMISSION_DETAIL
    })
  }
  if (raw.turns !== undefined && !(Number.isInteger(raw.turns) && raw.turns >= 1)) {
    throw new SporeError(`${file} has a turns that is not a count`, {
      type: 'CONFIG_INVALID',
      detail: 'turns is how many of your turns may run at once, a whole number from 1'
    })
  }
  if (raw.admission === 'caller' && raw.turns !== undefined) {
    throw new SporeError(`${file} has a turns, and its caller admits turns`, {
      type: 'CONFIG_INVALID',
      detail: 'turns bounds turns under spore admission; under caller admission the program in front of spore bounds them — spore config rm turns'
    })
  }
  if (raw.modelSessions !== undefined && !(Number.isInteger(raw.modelSessions) && raw.modelSessions >= 1)) {
    throw new SporeError(`${file} has a modelSessions that is not a count`, {
      type: 'CONFIG_INVALID',
      detail: 'modelSessions is how many model calls one running turn and its cells may have going at once, a whole number from 1'
    })
  }
  if (raw.homeSplit !== undefined && !(Number.isInteger(raw.homeSplit) && raw.homeSplit >= 1 && raw.homeSplit <= 8)) {
    throw new SporeError(`${file} has a homeSplit that is not a count from 1 to 8`, {
      type: 'CONFIG_INVALID',
      detail: 'homeSplit is how many of a spore\'s last characters name the directory it sits in under home, a whole number from 1 to 8'
    })
  }
  const allowed = (entry) => isRecord(entry) && isRecord(entry.settings) && typeof entry.version === 'string' && typeof entry.dir === 'string'
  if (raw.plugins !== undefined && !(isRecord(raw.plugins) && Object.values(raw.plugins).every(allowed))) {
    throw new SporeError(`${file} has a plugins that is not what spore plugin allow writes`, {
      type: 'CONFIG_INVALID',
      detail: 'plugins maps each allowed plugin to its settings and the copy allowed, as { "browser": { "settings": { "cdp": 9222 }, "version", "dir" } } — remove "plugins" from it, then spore plugin allow each one again'
    })
  }
  if (raw.replyTo !== undefined && !isRecord(raw.replyTo)) {
    throw new SporeError(`${file} has a replyTo that is not a map`, {
      type: 'CONFIG_INVALID',
      detail: 'replyTo maps a spore to where its answers go when what it read asked from nowhere, as { "triage": "discord:ops/1234" }'
    })
  }
  for (const [spore, place] of Object.entries(raw.replyTo ?? {})) {
    const problem = typeof place === 'string' ? native.replyToProblem(place) : `got ${JSON.stringify(place)}`
    if (problem) {
      throw new SporeError(`${file} has a replyTo for ${spore} that is not a place`, {
        type: 'CONFIG_INVALID',
        detail: problem
      })
    }
  }
  if (raw.approvals !== undefined && !isRecord(raw.approvals)) {
    throw new SporeError(`${file} has an approvals that is not a map`, { type: 'CONFIG_INVALID', detail: APPROVALS_DETAIL })
  }
  for (const [name, hook] of Object.entries(raw.approvals ?? {})) {
    const fits = NAMES.approval.pattern.test(name) && isRecord(hook) && Object.keys(hook).every(key => key === 'url' || key === 'secret') &&
      typeof hook.url === 'string' && URL.canParse(hook.url) && ['http:', 'https:'].includes(new URL(hook.url).protocol) &&
      variableOf(hook.secret) !== null
    if (!fits) {
      throw new SporeError(`${file} has an approval hook "${name}" spore cannot read`, { type: 'CONFIG_INVALID', detail: APPROVALS_DETAIL })
    }
  }
  if (raw.contain !== undefined && typeof raw.contain !== 'boolean') {
    throw new SporeError(`${file} has a contain that is not true or false`, {
      type: 'CONFIG_INVALID',
      detail: 'contain says whether every turn, job, router and prepare step runs in namespaces of its own, seeing only its own processes — spore config set contain on|off'
    })
  }
  if (raw.docs !== undefined && !DOCS.includes(raw.docs)) {
    throw new SporeError(`${file} has a docs that is not follow or kept`, {
      type: 'CONFIG_INVALID',
      detail: DOCS_DETAIL
    })
  }
  for (const key of SIZES) {
    if (raw[key] !== undefined && !(typeof raw[key] === 'string' && native.sizeBytes(raw[key]) > 0)) {
      throw new SporeError(`${file} has a ${key} that is not a size`, {
        type: 'CONFIG_INVALID',
        detail: `${key} is a size such as 1GB, 512MB or a number of bytes`
      })
    }
  }
  for (const key of DURATIONS) {
    if (raw[key] !== undefined && !(typeof raw[key] === 'string' && native.durationMs(raw[key]) >= 1000)) {
      throw new SporeError(`${file} has a ${key} that is not a duration`, {
        type: 'CONFIG_INVALID',
        detail: `${key} is a duration such as 3h, 90m or 45s, from 1s`
      })
    }
  }
}

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

const switchOf = (value) => {
  if (Object.hasOwn(SWITCHES, value)) return SWITCHES[value]
  throw new SporeError(`contain is on or off, not "${value}"`, { type: 'CONFIG_INVALID', detail: 'spore config set contain on|off' })
}

/** Whether turns, jobs, routers and prepare steps must run contained: on unless the operator turned it off. */
export const containing = (config) => config.contain ?? DEFAULTS.contain

/** The longest `prepare.timeout` a spore may ask of this host, in ms: what the operator set, or an hour. */
export const prepareCeilingMs = (config) => config.prepareCeiling === undefined ? DEFAULTS.prepareCeiling : native.durationMs(config.prepareCeiling)

const admissionOf = (value) => {
  if (ADMISSIONS.includes(value)) return value
  throw new SporeError(`admission is spore or caller, not "${value}"`, { type: 'CONFIG_INVALID', detail: ADMISSION_DETAIL })
}

/** Whether the program in front of spore admits every turn on this host, so spore takes no slot and holds nothing for later. */
export const callerAdmits = (config) => (config.admission ?? DEFAULTS.admission) === 'caller'

/** The `config.json` beside a file that lives with it — `api.json`, `hooks.json`. */
export const configBeside = (path) => resolve(dirname(path), basename(CONFIG_FILE))

const docsOf = (value) => {
  if (DOCS.includes(value)) return value
  throw new SporeError(`docs is follow or kept, not "${value}"`, { type: 'CONFIG_INVALID', detail: DOCS_DETAIL })
}

/** Whether a runner's start replaces the root documents that differ from what is installed. */
export const followingDocs = (config) => (config.docs ?? DEFAULTS.docs) === 'follow'

/** How many sessions `spore here` keeps a snapshot of, per spore, the newest kept. */

/** A size setting in bytes, or null where the file leaves it to the runner's default. */
export const bytesOf = (config, key) => (config[key] === undefined ? null : Math.floor(native.sizeBytes(config[key])))

/** A duration setting in whole seconds, or null where the file leaves it to the runner's default. */
export const secondsOf = (config, key) => (config[key] === undefined ? null : Math.ceil(native.durationMs(config[key]) / 1000))

/**
 * A path in config outliving its directory is ordinary — a cleared scratch dir, a detached
 * worktree — and gets the same bargain an unreadable note gets from recall: say so, carry
 * on with the rest.
 */
export function existing (paths) {
  const live = []
  const missing = []
  for (const path of paths) (existsSync(path) ? live : missing).push(path)
  return { live, missing }
}

const KEYS = new Set(['home', 'homeSplit', 'workspaces', 'admission', 'turns', 'modelSessions', 'gate', 'callCeiling', 'prepareCeiling', 'largestFile', 'freeFloor', 'contain', 'docs'])
const DOCS = ['follow', 'kept']
const ADMISSIONS = ['spore', 'caller']
const ADMISSION_DETAIL = 'admission says who admits turns: spore, counting them in turns slots and holding deliveries for later, or caller, the one program in front of spore that schedules every turn, which spore then starts at once or refuses — spore config set admission spore|caller'
const APPROVALS_DETAIL = `approvals names each hook an approval may call, by a name of ${NAMES.approval.says}, as { "kpi": { "url": "https://…", "secret": "\${KPI_HOOK_SECRET}" } } — the secret set in environment beside config.json`
const DOCS_DETAIL = 'docs says whether a runner starts by replacing the root documents that differ from what is installed (follow) or leaves them to spore upgrade (kept) — spore config set docs follow|kept'
const SWITCHES = { on: true, off: false }
const COUNTS = new Set(['turns', 'modelSessions', 'homeSplit'])
const SIZES = new Set(['largestFile', 'freeFloor'])
const DURATIONS = new Set(['callCeiling', 'prepareCeiling'])
const LISTS = new Set(['workspaces'])

/**
 * Kept as written where it starts at `~` — `~/work/spores` survives a move between machines
 * and `readConfig` expands it on the way out. Anything relative is resolved now, because a
 * path meaning "wherever this was run from" means nothing the next time.
 */
const store = (value) => (value.startsWith('~') ? value : resolve(value))

/**
 * The file as written, not as resolved. Edits must round-trip what a person typed — a `~`
 * they used stays a `~` — so this validates through `readConfig` and then re-reads raw.
 */
const raw = (file) => {
  if (!existsSync(file)) return {}
  readConfig(file)
  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * Written whole and renamed into place. A configuration half-written by an interrupted
 * process is worse than one that was never edited: the next read refuses it, and the paths
 * it named are gone with it.
 */
function writeConfig (next, file = CONFIG_FILE) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  renameSync(temporary, file)
  return next
}

/**
 * How a home is laid out, written by `define` beside its first spore: `homeSplit` is chosen
 * before then and kept, since spores already made would not be where a new value puts them.
 * The leading dot keeps it from ever being read as a spore's name.
 */
export const HOME_RECORD = '.spore-home'

const laidOut = (home) => {
  const record = join(home, HOME_RECORD)
  if (!existsSync(record)) return undefined
  return JSON.parse(readFileSync(record, 'utf8')).homeSplit ?? null
}

const layoutText = (split) => (split ? `homeSplit ${split}` : 'flat')

function checkLayout (home, split, file) {
  const laid = laidOut(home)
  if (laid === undefined || laid === split) return
  throw new SporeError(`${home} holds spores laid out ${layoutText(laid)}, and ${file} says ${layoutText(split)}`, {
    type: 'CONFIG_HOME_LAID_OUT',
    detail: 'homeSplit is chosen before a home\'s first spore and kept — put it back, or point home at a directory of its own'
  })
}

/** Called by `define` once a spore is made in `home`: the first one fixes the layout. */
export function recordLayout (home, split) {
  try {
    writeFileSync(join(home, HOME_RECORD), JSON.stringify({ homeSplit: split ?? null }) + '\n', { flag: 'wx' })
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
}

const refuseRelayout = (current, split) => {
  if (!current.home) return
  const home = expand(current.home)
  if (laidOut(home) === undefined && !sporesInHome(home, current.homeSplit ?? null).length) return
  throw new SporeError(`${home} already holds spores, laid out ${layoutText(current.homeSplit ?? null)}`, {
    type: 'CONFIG_HOME_LAID_OUT',
    detail: `homeSplit is chosen before a home's first spore and kept${split ? ' — set it on a new home: spore config set home <dir>, then homeSplit' : ''}`
  })
}

const known = (key) => {
  if (KEYS.has(key)) return key
  throw new SporeError(`no such setting "${key}"`, {
    type: 'CONFIG_UNKNOWN_KEY',
    detail: `this file holds where workspaces live and what your spores may use together — ${[...KEYS].join(', ')}`
  })
}

export const NAMES_A_PATH = /^[.~]|\//

export const NAME = NAMES.spore.pattern

/**
 * What a spore's name or path points at, and for `new` what to make. `named` says which form
 * was used: a bare name resolves against `home`, anything path-shaped is taken as written.
 */
export function workspaceFor (asked, { config, cwd = process.cwd(), file = CONFIG_FILE } = {}) {
  if (!asked) return { path: resolve(cwd), named: false }
  if (NAMES_A_PATH.test(asked)) {
    return { path: asked.startsWith('~') ? join(homedir(), asked.slice(1)) : resolve(cwd, asked), named: false }
  }
  if (!NAME.test(asked)) {
    throw new SporeError(`"${asked}" is not a usable name`, {
      type: 'CONFIG_BAD_NAME',
      detail: `${NAMES.spore.says} — or pass a path`
    })
  }
  const { home, homeSplit } = config ?? readConfig(file)
  if (!home) {
    throw new SporeError(`"${asked}" is a name, and no home is set to put it in`, {
      type: 'CONFIG_NO_HOME',
      detail: 'spore config set home <dir> names the directory spores are made in, or pass a path'
    })
  }
  if (isWorkspace(home)) {
    throw new SporeError(`home is itself a workspace — ${home}`, {
      type: 'CONFIG_HOME_IS_A_WORKSPACE',
      detail: 'home holds workspaces, one per subdirectory, and is not one; a spore made inside another sits in that agent\'s own tree, readable to it'
    })
  }
  if (!homeSplit) return { path: join(home, asked), named: true, home }
  const split = asked.slice(-homeSplit)
  if (!/^[A-Za-z0-9_-]+$/.test(split)) {
    throw new SporeError(`"${asked}" ends in "${split}", which cannot name a directory`, {
      type: 'CONFIG_BAD_NAME',
      detail: `with homeSplit ${homeSplit}, a name's last ${homeSplit} characters name the directory it sits in under home — letters, digits, dash and underscore`
    })
  }
  return { path: join(home, split, asked), named: true, home }
}

/**
 * `plugins` is written by `spore plugin allow` and `disallow`, which check a plugin before
 * recording it, and not by `config set`: a setting a plugin never declared is a typo nobody
 * would be told about.
 */
export function setPlugin (name, record, file = CONFIG_FILE) {
  const current = raw(file)
  return writeConfig({ ...current, plugins: { ...current.plugins, [name]: record } }, file)
}

export function unsetPlugin (name, file = CONFIG_FILE) {
  const current = raw(file)
  const { [name]: _gone, ...rest } = current.plugins ?? {}
  return writeConfig({ ...current, plugins: rest }, file)
}

/** What spores may use when the configuration says nothing, from the crate that enforces it. */
export const DEFAULTS = Object.freeze({
  admission: 'spore',
  turns: native.defaultTurns(),
  modelSessions: native.defaultModelSessions(),
  largestFile: native.defaultLargestFile(),
  freeFloor: native.defaultFreeFloor(),
  callCeiling: native.defaultCallCeilingMs(),
  prepareCeiling: 3_600_000,
  contain: true,
  docs: 'kept'
})

/**
 * Every setting with the value in effect and where it comes from: `set` in this file, the
 * runtime's `default`, or `unset` when nothing stands in for it.
 */
export function settings (file = CONFIG_FILE) {
  const current = raw(file)
  return [...KEYS].map(key => {
    if (current[key] !== undefined) return { key, value: current[key], from: 'set' }
    if (key === 'turns' && callerAdmits(current)) return { key, value: null, from: 'unset' }
    if (key in DEFAULTS) return { key, value: SIZES.has(key) ? sizeSpelling(DEFAULTS[key]) : DURATIONS.has(key) ? durationSpelling(DEFAULTS[key]) : DEFAULTS[key], from: 'default' }
    return { key, value: LISTS.has(key) ? [] : null, from: 'unset' }
  }).concat(current.plugins === undefined ? [] : [{ key: 'plugins', value: Object.keys(current.plugins), from: 'set' }])
    .concat(current.replyTo === undefined ? [] : [{ key: 'replyTo', value: current.replyTo, from: 'set' }])
}

export function getKey (key, file = CONFIG_FILE) {
  const current = raw(file)
  if (!key) return current
  return { [known(key)]: current[key] ?? (LISTS.has(key) ? [] : null) }
}

export function setKey (key, value, file = CONFIG_FILE) {
  const current = raw(file)
  known(key)
  if (key === 'homeSplit' && Number(value) !== (current.homeSplit ?? null)) refuseRelayout(current, Number(value))
  const next = LISTS.has(key)
    ? value.split(',').map(v => store(v.trim())).filter(Boolean)
    : COUNTS.has(key) ? Number(value) : SIZES.has(key) || DURATIONS.has(key) ? value : key === 'contain' ? switchOf(value) : key === 'docs' ? docsOf(value) : key === 'admission' ? admissionOf(value) : store(value)
  const written = { ...current, [key]: next }
  validate(written, file)
  if (key === 'home') checkLayout(expand(next), written.homeSplit ?? null, file)
  return writeConfig(written, file)
}

export function addTo (key, value, file = CONFIG_FILE) {
  if (!LISTS.has(known(key))) throw new SporeError(`${key} is not a list — use set`, { type: 'CONFIG_NOT_A_LIST' })
  const current = raw(file)
  const list = current[key] || []
  const entry = store(value)
  if (list.includes(entry)) return current
  return writeConfig({ ...current, [key]: [...list, entry] }, file)
}

export function removeFrom (key, value, file = CONFIG_FILE) {
  const current = raw(file)
  if (value === undefined) {
    if (key === 'homeSplit' && current.homeSplit !== undefined) refuseRelayout(current, null)
    const { [known(key)]: _gone, ...rest } = current
    return writeConfig(rest, file)
  }
  if (!LISTS.has(known(key))) throw new SporeError(`${key} is not a list — rm it whole`, { type: 'CONFIG_NOT_A_LIST' })
  const entry = store(value)
  return writeConfig({ ...current, [key]: (current[key] || []).filter(v => v !== entry) }, file)
}
