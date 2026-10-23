/**
 * Plugins: packages named `spore-plugin-<name>`, installed beside spore, that give the spores
 * using them programs, documentation and precursors. Contract: ARCHITECTURE.md, "Plugins".
 *
 * The core reads a plugin's manifest and runs none of its code. What a manifest names is run
 * by the agent, as any program is, inside its sandbox, which reads each plugin a spore uses and
 * the packages it depends on — never the `node_modules` they share. A plugin's services are the
 * one thing run on the host, by systemd, once the operator defines one with `spore service`.
 */

import { accessSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import semver from 'semver'

import { readConfig, setPlugin, unsetPlugin, CONFIG_FILE } from '../library/config.js'
import { parseDefinition, PRECURSOR_DIR, PRECURSOR_EXT } from '../delegation/definition.js'
import { PROVISIONED_MODULES } from '../delegation/agent-env.js'
import { copyAbsent } from '../delegation/precursor-catalog.js'
import { SporeError } from '../observability/errors.js'
import { native } from '../native.js'
import { systemReadPaths } from '../isolation/sandbox.js'
import { sporangiumOf, sporangiumTree } from './sporangia.js'
import { DATA_DIR, definitionPath, LIBRARIES_FILE, PASSED_THROUGH, PLUGIN_CALLS, PLUGINS_DIR, REFERENCE_FILE, RUNTIME_ENV } from './spore-dir.js'
import { TOOL_NAMES } from './tool-names.js'
import { pluginCallRows } from './call-table.js'

const SPORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SPORE_PACKAGE = JSON.parse(readFileSync(join(SPORE_ROOT, 'package.json'), 'utf8'))

const PREFIX = 'spore-plugin-'
export const PLUGIN_READS = 'SPORE_PLUGIN_READS'
const MANIFEST_FIELDS = ['works', 'settings', 'programs', 'routes', 'describe', 'env', 'contain', 'modules', 'sources', 'reference', 'precursors', 'services']
const CONTAIN_FIELDS = ['hide', 'keep', 'missing']
const SERVICE_FIELDS = ['what', 'program', 'instances', 'check']
const SERVICE_NAME = /^[a-z][a-z0-9-]*$/
const FILE_NAME = /^[a-z0-9][a-z0-9._-]*$/i
const SETTING_KINDS = ['port', 'text']
const PLACEHOLDERS = ['name', 'ws', 'data', 'sockets']
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const PLACEHOLDER = /\{([^{}]*)\}/g

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

const ancestors = (path) => {
  const found = []
  for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) found.push(dir)
  return found
}

const within = (path, dir) => path === dir || path.startsWith(dir + sep)

/**
 * Where plugins are looked for: spore's own `node_modules`, every `node_modules` it is installed
 * under — inside the CLI's, and the global one `npm i -g` puts a plugin in — and, in a checkout,
 * `rust/workspace`'s `node_modules_root`.
 */
export function pluginRoots (root = SPORE_ROOT) {
  const installed = ancestors(root).filter(dir => basename(dir) === 'node_modules')
  const hoisted = native.nodeModulesRoot(root)
  return [...new Set([join(root, 'node_modules'), ...installed, ...(hoisted ? [hoisted] : [])])].filter(dir => existsSync(dir))
}

export function installedPlugins (roots = pluginRoots()) {
  const found = []
  for (const root of roots) {
    const add = (packageName) => found.push({ name: basename(packageName).slice(PREFIX.length), package: packageName, dir: join(root, packageName), root })
    for (const entry of readdirSync(root).sort()) {
      if (entry.startsWith(PREFIX)) add(entry)
      if (!entry.startsWith('@')) continue
      for (const inner of readdirSync(join(root, entry)).sort()) {
        if (inner.startsWith(PREFIX)) add(`${entry}/${inner}`)
      }
    }
  }
  return found
}

function findPlugin (name, roots) {
  const found = installedPlugins(roots).filter(p => p.name === name)
  if (!found.length) {
    throw new SporeError(`no plugin "${name}" is installed beside spore`, {
      type: 'PLUGIN_NOT_INSTALLED',
      detail: `a plugin is a package named ${PREFIX}${name}, installed where spore is — ${roots.join(', ') || 'no node_modules found'}`
    })
  }
  if (found.length > 1) {
    throw new SporeError(`two packages are plugin "${name}" — ${found.map(p => p.package).join(' and ')}`, {
      type: 'PLUGIN_AMBIGUOUS',
      detail: 'uninstall one of them'
    })
  }
  return found[0]
}

function readManifest (found) {
  const refuse = (problem, detail) => new SporeError(`plugin ${found.name} (${found.package}) ${problem}`, { type: 'PLUGIN_INVALID', detail })
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(found.dir, 'package.json'), 'utf8'))
  } catch (err) {
    throw refuse('has no readable package.json', err.message)
  }
  if (!isRecord(pkg.spore)) {
    throw refuse('has no "spore" manifest in its package.json', `the manifest says what the plugin gives: ${MANIFEST_FIELDS.join(', ')}`)
  }
  return { pkg, manifest: pkg.spore, refuse }
}

const installedFrom = (dir, pkg) => [dir, ...ancestors(dir)].map(at => join(at, 'node_modules', pkg)).find(at => existsSync(at))

/**
 * The plugin and every package it depends on, as Node resolves them from it, each its real
 * directory: what the sandbox grants an agent using it.
 */
function closure (found, refuse) {
  const dirs = new Set()
  const visit = (dir) => {
    const real = realpathSync(dir)
    if (dirs.has(real)) return
    dirs.add(real)
    const pkg = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8'))
    for (const [names, required] of [[pkg.dependencies, true], [pkg.optionalDependencies, false]]) {
      for (const name of Object.keys(names ?? {})) {
        const at = installedFrom(real, name)
        if (at) visit(at)
        else if (required) throw refuse(`depends on ${name}, which is not installed`, `installing the plugin installs what it depends on — reinstall ${found.package}`)
      }
    }
  }
  visit(found.dir)
  return [...dirs]
}

/** `./bin/x` in the plugin, or `<package>/<path>` in a package it depends on. */
function locate (found, spec, refuse) {
  if (typeof spec !== 'string' || !spec || isAbsolute(spec)) {
    throw refuse(`names a program as "${spec}"`, 'a program is ./<path> in the plugin, or <package>/<path> in one it depends on')
  }
  if (spec.startsWith('./')) return inside(found, spec, refuse)
  const parts = spec.split('/')
  const depth = spec.startsWith('@') ? 2 : 1
  const pkg = parts.slice(0, depth).join('/')
  const home = installedFrom(found.dir, pkg)
  if (!home) throw refuse(`names a program in ${pkg}, which is not installed`, `installing the plugin installs what it depends on — reinstall ${found.package}`)
  return join(home, ...parts.slice(depth))
}

function inside (found, path, refuse) {
  const at = typeof path === 'string' ? resolve(found.dir, path) : null
  if (!at || isAbsolute(path) || !within(at, found.dir)) {
    throw refuse(`names ${path}, outside itself`, 'paths in a manifest are relative to the plugin')
  }
  if (!existsSync(at)) throw refuse(`names ${path}, which it does not contain`, 'a published plugin carries every file its manifest names — check its package.json "files"')
  return at
}

const upper = (name) => name.toUpperCase().replace(/[^A-Z0-9]/g, '_')

/**
 * A plugin may not set what the runtime sets, or it would quietly win over it or lose to it.
 * `SPORE_*` is the runtime's except the plugin's own prefix: `SPORE_BROWSER` for `browser`.
 */
function checkEnvName (found, name, refuse) {
  const own = `SPORE_${upper(found.name)}`
  const reserved = RUNTIME_ENV.includes(name) || PASSED_THROUGH.includes(name) ||
    (name.startsWith('SPORE_') && name !== own && !name.startsWith(`${own}_`))
  if (!ENV_NAME.test(name) || reserved) {
    throw refuse(`sets ${name}, which it may not`, `a plugin's variables are its own: ${own} or ${own}_*, or a name the runtime does not set`)
  }
}

const fits = (kind, value) => kind === 'port'
  ? Number.isInteger(value) && value >= 1 && value <= 65535
  : typeof value === 'string' && value.length > 0

/**
 * A plugin, installed and checked: its manifest read, what it names found, its precursors
 * parsed. `settings` are the host's for it, checked against what it declares; null checks the
 * plugin alone, which is what listing one needs.
 */
export function checkPlugin (found, settings = null) {
  const { pkg, manifest, refuse } = readManifest(found)
  const unknown = Object.keys(manifest).filter(key => !MANIFEST_FIELDS.includes(key))
  if (unknown.length) throw refuse(`has a manifest field spore does not know — ${unknown.join(', ')}`, `a manifest takes ${MANIFEST_FIELDS.join(', ')}`)

  const range = manifest.works
  if (typeof range !== 'string' || !semver.validRange(range)) {
    throw refuse('does not say which spore it works with', `works names the ${SPORE_PACKAGE.name} versions it works with, as "works": ">=0.3 <1"`)
  }
  if (!semver.satisfies(SPORE_PACKAGE.version, range, { includePrerelease: true })) {
    throw new SporeError(`plugin ${found.name} (${found.package} ${pkg.version}) does not work with this spore`, {
      type: 'PLUGIN_INCOMPATIBLE',
      detail: `it works with ${SPORE_PACKAGE.name} ${range}, and this is ${SPORE_PACKAGE.version}`
    })
  }

  const kinds = manifest.settings ?? {}
  if (!isRecord(kinds) || Object.values(kinds).some(kind => !SETTING_KINDS.includes(kind))) {
    throw refuse('declares settings spore cannot read', `settings maps each to its kind — ${SETTING_KINDS.join(' or ')}`)
  }
  if (settings) {
    for (const key of Object.keys(settings)) {
      if (!(key in kinds)) {
        throw new SporeError(`plugin ${found.name} has no setting "${key}"`, {
          type: 'PLUGIN_SETTING_UNKNOWN',
          detail: Object.keys(kinds).length ? `it takes ${Object.keys(kinds).join(', ')}` : 'it takes none'
        })
      }
    }
    for (const [key, kind] of Object.entries(kinds)) {
      if (settings[key] === undefined) {
        throw new SporeError(`plugin ${found.name} needs ${key}`, { type: 'PLUGIN_SETTING_MISSING', detail: `spore plugin allow ${found.name} ${key}=<${kind}>` })
      }
      if (!fits(kind, settings[key])) {
        throw new SporeError(`plugin ${found.name} has a ${key} that is not a ${kind} — ${settings[key]}`, {
          type: 'PLUGIN_SETTING_INVALID',
          detail: kind === 'port' ? 'a port is a whole number from 1 to 65535' : 'text is a non-empty string'
        })
      }
    }
  }

  const reads = closure(found, refuse)
  const programs = {}
  if (!isRecord(manifest.programs ?? {})) throw refuse('has programs that are not a map', 'programs maps a variable to the program it names, as { "SPORE_X": "./bin/x" }')
  for (const [name, spec] of Object.entries(manifest.programs ?? {})) {
    checkEnvName(found, name, refuse)
    programs[name] = runnable(found, `a program ${name}`, spec, reads, refuse)
  }

  const routes = {}
  if (!isRecord(manifest.routes ?? {})) throw refuse('has routes that are not a map', 'routes maps a router\'s name to its program, as { "mine": "./bin/mine.js" }')
  for (const [name, spec] of Object.entries(manifest.routes ?? {})) {
    if (!SERVICE_NAME.test(name)) throw refuse(`has a router named "${name}"`, 'a router\'s name is lowercase letters, digits and -')
    routes[name] = runnable(found, `a router ${name}`, spec, reads, refuse)
  }

  const env = {}
  if (!isRecord(manifest.env ?? {})) throw refuse('has an env that is not a map', 'env maps a variable to its value, as { "X_PORT": "{settings.port}" }')
  for (const [name, template] of Object.entries(manifest.env ?? {})) {
    checkEnvName(found, name, refuse)
    if (name in programs) throw refuse(`sets ${name} as a program and in env`, 'one or the other')
    if (typeof template !== 'string') throw refuse(`sets ${name} to something other than text`, 'env values are strings, with {placeholders}')
    checkPlaceholders(`sets ${name}`, template, kinds, refuse)
    env[name] = template
  }

  const contain = checkContain(manifest.contain, kinds, refuse)

  const modules = checkModules(pkg, manifest.modules ?? [], found, refuse)
  const sources = checkSources(manifest.sources ?? {}, refuse)

  const reference = manifest.reference === undefined ? null : inside(found, manifest.reference, refuse)
  if (reference && !statSync(reference).isFile()) throw refuse(`names a reference that is not a file — ${manifest.reference}`, 'the reference is one markdown file')

  const precursors = []
  if (manifest.precursors !== undefined) {
    const dir = inside(found, manifest.precursors, refuse)
    for (const file of readdirSync(dir).filter(f => f.endsWith(PRECURSOR_EXT)).sort()) {
      const parsed = parseDefinition(readFileSync(join(dir, file), 'utf8'), { knownTools: TOOL_NAMES, cell: true })
      if (parsed.error) throw refuse(`has a precursor ${file} that does not parse — ${parsed.error}`, 'a precursor is checked as a cell\'s definition')
      if (`${parsed.name}${PRECURSOR_EXT}` !== file) throw refuse(`has a precursor ${file} named ${parsed.name}`, 'a precursor is spawned by its file name, so the two agree')
      precursors.push({ name: parsed.name, path: join(dir, file) })
    }
  }

  const services = checkServices(found, manifest.services ?? {}, refuse)
  const describe = checkDescribe(found, manifest.describe ?? [], Object.keys(programs), refuse)

  return { name: found.name, package: found.package, version: pkg.version, dir: found.dir, range, kinds, settings, programs, routes, describe, env, contain, modules, sources, reference, precursors, reads, services }
}

/** `spec` located and checked as something run: there, executable, inside the plugin's reads. */
function runnable (found, what, spec, reads, refuse) {
  const path = locate(found, spec, refuse)
  if (!existsSync(path) || !statSync(path).isFile()) throw refuse(`names ${what} that is not there — ${path}`, 'reinstall it')
  try {
    accessSync(path, constants.X_OK)
  } catch {
    throw refuse(`names ${what} that is not executable — ${path}`, 'a program is run, so it needs its executable bit')
  }
  if (!reads.some(dir => within(realpathSync(path), dir))) {
    throw refuse(`names ${what} outside itself and what it depends on — ${realpathSync(path)}`, 'only what the sandbox reads can run: the plugin and its dependencies')
  }
  return path
}

function checkDescribe (found, describe, programs, refuse) {
  if (!Array.isArray(describe) || !describe.every(isRecord)) {
    throw refuse('has a describe that is not a list', 'describe lists how a call of each of its programs is shown, as [{ "program": "^\\"?\\\\$SPORE_X", "title": "using x", "category": "execute" }]')
  }
  try {
    return pluginCallRows(found.name, describe, programs)
  } catch (err) {
    throw refuse(`has a describe spore cannot use — ${err.message}`, 'each row matches a command running one of its programs, with a title and a category')
  }
}

function checkPlaceholders (what, template, kinds, refuse) {
  for (const [, key] of template.matchAll(PLACEHOLDER)) {
    const known = PLACEHOLDERS.includes(key) || (key.startsWith('settings.') && key.slice('settings.'.length) in kinds)
    if (!known) throw refuse(`${what} with {${key}}, which spore does not fill`, `placeholders are ${PLACEHOLDERS.map(p => `{${p}}`).join(', ')} and {settings.<key>} for a declared setting`)
  }
}

/**
 * A directory of the host a plugin hides from a contained spore, and the one inside it the spore
 * keeps in view, if any — its own socket among the sockets of every spore, say — with what it
 * means when that directory is not there. `confine --contain` lays it out; a spore not contained
 * is refused.
 */
function checkContain (declared, kinds, refuse) {
  if (declared === undefined) return null
  const shape = 'contain is { "hide": "<a directory>" }, or with "keep": "<a directory inside it>" and "missing": "<what it means when keep is not there>"'
  if (!isRecord(declared) || !('hide' in declared) || Object.keys(declared).some(key => !CONTAIN_FIELDS.includes(key)) || ('keep' in declared) !== ('missing' in declared)) {
    throw refuse('has a contain spore cannot read', shape)
  }
  for (const field of CONTAIN_FIELDS.filter(field => field in declared)) {
    if (typeof declared[field] !== 'string' || !declared[field]) throw refuse(`has a contain whose ${field} is not text`, shape)
    checkPlaceholders(`sets contain.${field}`, declared[field], kinds, refuse)
  }
  return declared
}

/**
 * Endpoints the plugin describes as the host's `sources.json` does: the runner holds them and
 * fills their `${SECRET}`s from its own environment, so neither the address nor the key reaches
 * an agent. A spore using the plugin is granted them; the runner checks each fully when it starts.
 */
function checkSources (declared, refuse) {
  if (!isRecord(declared)) throw refuse('has sources that are not a map', 'sources maps a name to an endpoint, as { "web": { "url": "https://…" } }')
  for (const [name, spec] of Object.entries(declared)) {
    if (!SERVICE_NAME.test(name)) throw refuse(`has a source named "${name}"`, 'a source is named in lower-case letters, digits and -, starting with a letter')
    if (!isRecord(spec) || typeof spec.url !== 'string' || !/^https?:\/\//.test(spec.url)) {
      throw refuse(`has a source ${name} with no http:// or https:// url`, 'a source is described as the host\'s sources.json describes one: url, and headers, query, requires, methods or paths')
    }
    const wrong = misplaced(spec)
    if (wrong) throw refuse(`has a source ${name} with ${wrong.found} in ${wrong.where}`, wrong.why)
  }
  return declared
}

/** Libraries an agent's own programs may import, each one of the plugin's own dependencies, by where it is installed. */
function checkModules (pkg, declared, found, refuse) {
  if (!Array.isArray(declared)) throw refuse('has modules that are not a list', 'modules names the dependencies an agent\'s programs may import, as ["sharp"]')
  const modules = {}
  for (const name of declared) {
    if (typeof name !== 'string' || !(name in (pkg.dependencies ?? {}))) {
      throw refuse(`offers a module ${name} it does not depend on`, 'a module is one of the plugin\'s own dependencies, so the sandbox already reads it')
    }
    if (PROVISIONED_MODULES.includes(name)) throw refuse(`offers ${name}, which every spore is already given`, 'drop it from modules')
    modules[name] = realpathSync(installedFrom(found.dir, name))
  }
  return modules
}

/**
 * A service is a Node program the host runs under systemd, outside every sandbox, and spore
 * writes its unit: the manifest says what it is and which file starts it, never a unit line.
 */
function checkServices (found, declared, refuse) {
  if (!isRecord(declared)) throw refuse('has services that are not a map', 'services maps a name to what the host runs, as { "relay": { "what": "…", "program": "./bin/relay.js" } }')
  const services = {}
  for (const [name, spec] of Object.entries(declared)) {
    if (!SERVICE_NAME.test(name)) throw refuse(`has a service named "${name}"`, 'a service is named in lower-case letters, digits and -, starting with a letter')
    if (!isRecord(spec)) throw refuse(`has a service ${name} that is not a map`, `a service takes ${SERVICE_FIELDS.join(', ')}`)
    const unknown = Object.keys(spec).filter(key => !SERVICE_FIELDS.includes(key))
    if (unknown.length) throw refuse(`has a service ${name} with a field spore does not know — ${unknown.join(', ')}`, `a service takes ${SERVICE_FIELDS.join(', ')}`)
    if (typeof spec.what !== 'string' || !spec.what) throw refuse(`has a service ${name} that does not say what it is`, 'what is the line spore service ls shows for it')
    const program = inside(found, spec.program, refuse)
    if (!statSync(program).isFile()) throw refuse(`has a service ${name} whose program is not a file — ${spec.program}`, 'the program is the script Node starts')
    const instances = spec.instances ?? null
    if (instances !== null && !(isRecord(instances) && FILE_NAME.test(instances.dir ?? '') && /^\.[a-z0-9]+$/i.test(instances.ext ?? '') && SERVICE_NAME.test(instances.called ?? ''))) {
      throw refuse(`has a service ${name} with instances spore cannot read`, 'instances names the folder beside config.json holding one file per instance, as { "dir": "relay", "ext": ".json", "called": "bot" }')
    }
    const check = spec.check ?? null
    if (check !== null && !(Array.isArray(check) && check.every(arg => typeof arg === 'string' && arg))) {
      throw refuse(`has a service ${name} whose check is not a list of arguments`, 'check is what the program is given to test that it can start, as ["--check"]')
    }
    services[name] = { what: spec.what, program, instances, check }
  }
  return services
}

function filled (plugin, ws) {
  const values = {
    name: basename(ws),
    ws,
    data: join(ws, DATA_DIR),
    sockets: native.sporeSocketDir(ws),
    ...Object.fromEntries(Object.entries(plugin.settings).map(([key, value]) => [`settings.${key}`, String(value)]))
  }
  return (template) => template.replace(PLACEHOLDER, (_, key) => values[key])
}

function fill (plugin, ws) {
  const value = filled(plugin, ws)
  return {
    ...plugin.programs,
    ...Object.fromEntries(Object.entries(plugin.env).map(([name, template]) => [name, value(template)]))
  }
}

/** The plugin's `contain` for this spore, `{ plugin, hide, keep, missing }`, or null. */
function keptOf (plugin, ws) {
  if (!plugin.contain) return null
  const value = filled(plugin, ws)
  const plain = (path) => isAbsolute(path) && normalize(path) === path && !path.endsWith(sep)
  const hide = value(plugin.contain.hide)
  if (plugin.contain.keep === undefined) {
    if (plain(hide)) return { plugin: plugin.name, hide }
    throw new SporeError(`plugin ${plugin.name} hides ${hide}, which is not a directory`, {
      type: 'PLUGIN_CONTAIN_INVALID',
      detail: `it is an absolute path, written plainly — check spore plugin show ${plugin.name}`
    })
  }
  const [keep, missing] = [value(plugin.contain.keep), value(plugin.contain.missing)]
  if (!plain(hide) || !plain(keep) || !keep.startsWith(`${hide}${sep}`)) {
    throw new SporeError(`plugin ${plugin.name} keeps ${keep}, which is not a directory inside the ${hide} it hides`, {
      type: 'PLUGIN_CONTAIN_INVALID',
      detail: `both are absolute paths, written plainly, and one lies inside the other — check spore plugin show ${plugin.name}`
    })
  }
  return { plugin: plugin.name, hide, keep, missing }
}

const overlapping = (a, b) => a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`)

/**
 * What a contained process of this spore keeps in view of what its plugins hide — the agent's,
 * a job's, a router's, a cell's outside any turn — with nothing copied or linked.
 */
export function containOf (ws, { config = readConfig(), roots = pluginRoots() } = {}) {
  return (usedPlugins(ws, config, roots) ?? []).map(plugin => keptOf(plugin, ws)).filter(Boolean)
}

/** The plugins the spore's definition names, each allowed and checked; null with no readable definition. */
function usedPlugins (ws, config, roots) {
  if (!existsSync(definitionPath(ws))) return null
  const definition = parseDefinition(readFileSync(definitionPath(ws), 'utf8'), { knownTools: TOOL_NAMES })
  if (definition.error) return null
  return definition.plugins.map(name => {
    const allowed = config.plugins?.[name]
    if (!allowed) {
      throw new SporeError(`${ws} uses plugin "${name}", which is not allowed`, {
        type: 'PLUGIN_NOT_ALLOWED',
        detail: `spore plugin allow ${name}, or drop it from plugins: in its spore.cmk`
      })
    }
    return allowedPlugin(name, allowed, roots)
  })
}

/** What `allow` records of a plugin: the settings it was given, and which installed copy it was. */
const recordOf = (plugin) => ({ settings: plugin.settings, version: plugin.version, dir: realpathSync(plugin.dir) })

/** The plugin as allowed, refused when the installed copy is not the one that was. */
function allowedPlugin (name, allowed, roots) {
  const plugin = checkPlugin(findPlugin(name, roots), allowed.settings)
  const now = recordOf(plugin)
  if (now.version !== allowed.version || now.dir !== allowed.dir) {
    throw new SporeError(`plugin ${name} changed since it was allowed — ${allowed.version} at ${allowed.dir}, now ${now.version} at ${now.dir}`, {
      type: 'PLUGIN_CHANGED',
      detail: `spore plugin allow ${name} accepts the installed one`
    })
  }
  return plugin
}

/**
 * A path inside one the sandbox grants already, or inside another plugin's, would add nothing
 * but a rule toward the most `confine` takes: a plugin installed beside spore adds none.
 */
function readsOf (plugins) {
  const reads = [...new Set(plugins.flatMap(plugin => plugin.reads))]
  const granted = systemReadPaths().filter(path => existsSync(path)).map(path => realpathSync(path))
  return reads.filter(path => !granted.some(dir => within(path, dir)) && !reads.some(other => other !== path && within(path, other)))
}

/**
 * A definition that does not parse gets nothing here: the agent refuses it, and the turn it
 * records says why.
 *
 * @returns {{ env: Record<string, string>, plugins: object[], sources: object }} `env` is for the
 * agent, through the runner; it carries `SPORE_PLUGIN_READS`, what the agent's sandbox grants it of
 * the plugins, when there are any. `sources` are the plugins' endpoints, for the runner alone
 */
export function preparePlugins (ws, { config = readConfig(), roots = pluginRoots() } = {}) {
  const used = usedPlugins(ws, config, roots)
  if (!used) return { env: {}, plugins: [], sources: {}, contain: [] }
  const env = {}
  const from = {}
  const modules = {}
  const sources = {}
  const describedBy = {}
  const contain = []
  const calls = []
  const plugins = []
  for (const plugin of used) {
    const { name } = plugin
    const kept = keptOf(plugin, ws)
    if (kept) {
      const other = contain.find(k => overlapping(k.hide, kept.hide))
      if (other) throw new SporeError(`plugins ${other.plugin} and ${name} both hide ${kept.hide}`, { type: 'PLUGIN_CONFLICT', detail: 'a spore can use one of them, not both' })
      contain.push(kept)
    }
    for (const [key, value] of Object.entries(fill(plugin, ws))) {
      if (from[key]) {
        throw new SporeError(`plugins ${from[key]} and ${name} both set ${key}`, { type: 'PLUGIN_CONFLICT', detail: 'a spore can use one of them, not both' })
      }
      from[key] = name
      env[key] = value
    }
    for (const [module, dir] of Object.entries(plugin.modules)) {
      if (modules[module]) {
        throw new SporeError(`plugins ${modules[module].from} and ${name} both offer ${module}`, { type: 'PLUGIN_CONFLICT', detail: 'a spore can use one of them, not both' })
      }
      modules[module] = { dir, from: name }
    }
    for (const [source, spec] of Object.entries(plugin.sources)) {
      if (describedBy[source]) {
        throw new SporeError(`plugins ${describedBy[source]} and ${name} both describe the source ${source}`, { type: 'PLUGIN_CONFLICT', detail: 'a spore can use one of them, not both' })
      }
      describedBy[source] = name
      sources[source] = spec
    }
    if (plugin.reference) copyAbsent(plugin.reference, join(ws, PLUGINS_DIR, `${name}.md`))
    for (const precursor of plugin.precursors) copyAbsent(precursor.path, join(ws, PRECURSOR_DIR, basename(precursor.path)))
    calls.push(...plugin.describe)
    plugins.push(plugin)
  }
  linkModules(ws, Object.fromEntries(Object.entries(modules).map(([module, { dir }]) => [module, dir])))
  if (plugins.length) env[PLUGIN_READS] = JSON.stringify(readsOf(plugins))
  if (calls.length) env[PLUGIN_CALLS] = JSON.stringify(calls)
  return { env, plugins, sources, contain }
}

/**
 * `<ws>/node_modules` holds one link per library a spore is offered: the provisioned ones,
 * laid when the workspace opens, and those of the plugins it uses. A link no longer offered
 * goes, so dropping a plugin takes its libraries with it; what is not a link was not put
 * there by spore and is left alone.
 */
function linkModules (ws, modules) {
  const dir = join(ws, 'node_modules')
  const present = !existsSync(dir)
    ? []
    : readdirSync(dir).flatMap(entry => entry.startsWith('@') ? readdirSync(join(dir, entry)).map(inner => `${entry}/${inner}`) : [entry])
  for (const name of present) {
    const at = join(dir, name)
    if (!lstatSync(at).isSymbolicLink() || PROVISIONED_MODULES.includes(name)) continue
    if (modules[name] !== readlinkSync(at)) unlinkSync(at)
  }
  for (const [name, target] of Object.entries(modules)) {
    const at = join(dir, name)
    if (lstatSync(at, { throwIfNoEntry: false })) continue
    mkdirSync(dirname(at), { recursive: true })
    symlinkSync(target, at)
  }
}

/**
 * The documentation at a workspace's root that is not what is installed: its sporangium's
 * `reference.md` and `libraries.md`, and the reference of each plugin it uses. Copied when absent and replaced only by `upgrade`,
 * so a newer package does not change what a spore was told without its operator knowing.
 * Whether a file differs because the package moved or because someone edited it, nothing
 * here can tell, and nothing claims to.
 *
 * A plugin that is not allowed, not installed or not valid is left out: `send` refuses it, and
 * says why.
 */
export function differingDocs (ws, { config = readConfig(), roots = pluginRoots() } = {}) {
  const tree = sporangiumTree(sporangiumOf(ws), { configFile: config.file })
  const docs = [REFERENCE_FILE, LIBRARIES_FILE].map(file => ({ file, installed: tree.get(file) }))
  const definition = existsSync(definitionPath(ws))
    ? parseDefinition(readFileSync(definitionPath(ws), 'utf8'), { knownTools: TOOL_NAMES })
    : { error: 'absent' }
  const installed = installedPlugins(roots)
  for (const name of definition.error ? [] : definition.plugins) {
    const found = installed.filter(p => p.name === name)
    if (!config.plugins?.[name] || found.length !== 1) continue
    let plugin
    try {
      plugin = checkPlugin(found[0])
    } catch {
      continue
    }
    if (plugin.reference) docs.push({ file: join(PLUGINS_DIR, `${name}.md`), installed: plugin.reference })
  }
  return docs.filter(({ file, installed }) => {
    const at = join(ws, file)
    return existsSync(at) && !readFileSync(at).equals(readFileSync(installed))
  })
}

export function upgradeDocs (ws, options = {}) {
  const replaced = differingDocs(ws, options)
  for (const { file, installed } of replaced) {
    const at = join(ws, file)
    const staged = join(dirname(at), `.${basename(at)}.${process.pid}`)
    copyFileSync(installed, staged)
    renameSync(staged, at)
  }
  return { ws, replaced: replaced.map(d => d.file) }
}

const SECRET = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

export const secretsIn = (described) => [...new Set([...JSON.stringify(described).matchAll(SECRET)].map(found => found[1]))]

const SOURCE_PLACEHOLDER = /(?<!\$)\{([A-Za-z_][\w.]*)\}/g
const placeholdersOf = (value) => [...String(value).matchAll(SOURCE_PLACEHOLDER)].map(found => found[1])

/**
 * A placeholder in a source's spec the runner would refuse, as `{ found, where, why }`, or null:
 * a header may hold `{name}` and no other, and nothing else may hold it.
 */
export function misplaced (spec) {
  if (!isRecord(spec)) return null
  for (const [header, value] of Object.entries(isRecord(spec.headers) ? spec.headers : {})) {
    const other = placeholdersOf(value).find(placeholder => placeholder !== 'name')
    if (other !== undefined) return { found: `{${other}}`, where: `its ${header} header`, why: "a header may hold {name}, the calling spore's name, which the runner fills" }
  }
  const elsewhere = [['url', spec.url], ['socket', spec.socket], ...Object.values(isRecord(spec.query) ? spec.query : {}).map(value => ['query', value])]
  for (const [field, value] of elsewhere) {
    if (value !== undefined && placeholdersOf(value).includes('name')) return { found: '{name}', where: `its ${field}`, why: 'only a header takes {name}, which the runner fills and the agent cannot replace' }
  }
  return null
}

const describe = (plugin) => ({
  name: plugin.name,
  package: plugin.package,
  version: plugin.version,
  dir: plugin.dir,
  works: plugin.range,
  settings: plugin.kinds,
  programs: plugin.programs,
  routes: plugin.routes,
  env: plugin.env,
  contain: plugin.contain,
  reference: plugin.reference,
  modules: Object.keys(plugin.modules),
  sources: Object.keys(plugin.sources),
  secrets: secretsIn(plugin.sources),
  precursors: plugin.precursors.map(p => p.name),
  reads: plugin.reads,
  services: Object.keys(plugin.services)
})

/**
 * The owner's router `name` of the installed plugin `plugin`: `{ program, reads }`, the program and
 * what it may read of the plugin and its dependencies.
 */
export function ownerRouter (plugin, name, roots = pluginRoots()) {
  const checked = checkPlugin(findPlugin(plugin, roots))
  const program = checked.routes[name]
  if (!program) {
    throw new SporeError(`plugin ${plugin} offers no router "${name}"`, {
      type: 'ROUTER_UNKNOWN',
      detail: Object.keys(checked.routes).length ? `it offers ${Object.keys(checked.routes).join(', ')}` : 'it offers none'
    })
  }
  return { program, reads: checked.reads }
}

const declaresServices = (found) => {
  try {
    return isRecord(readManifest(found).manifest.services)
  } catch {
    return false
  }
}

/**
 * Every service an installed plugin offers, allowed or not: defining one is the operator's
 * consent to run it, and `allow` is what spores may use. A plugin that declares services and
 * does not check is a problem to show, not a reason to list nothing.
 */
export function pluginServices (roots = pluginRoots()) {
  const services = []
  const problems = []
  for (const found of installedPlugins(roots)) {
    let plugin
    try {
      plugin = checkPlugin(found)
    } catch (err) {
      if (declaresServices(found)) problems.push({ plugin: found.name, package: found.package, problem: err.detail ? `${err.message} — ${err.detail}` : err.message })
      continue
    }
    for (const [name, service] of Object.entries(plugin.services)) {
      services.push({ name, ...service, plugin: plugin.name, package: plugin.package, version: plugin.version, dir: plugin.dir })
    }
  }
  return { services, problems }
}

export function listPlugins ({ configFile = CONFIG_FILE, roots = pluginRoots() } = {}) {
  const allowed = readConfig(configFile).plugins ?? {}
  const installed = installedPlugins(roots)
  const plugins = installed.map(found => {
    const record = allowed[found.name] ?? null
    let problem = null
    let version = null
    try {
      version = (record ? allowedPlugin(found.name, record, roots) : checkPlugin(found)).version
    } catch (err) {
      problem = err.detail ? `${err.message} — ${err.detail}` : err.message
    }
    return { name: found.name, package: found.package, version, dir: found.dir, allowed: Boolean(record), settings: record?.settings ?? null, problem }
  })
  const missing = Object.keys(allowed).filter(name => !installed.some(p => p.name === name))
  return { roots, plugins, missing }
}

export function showPlugin (name, { configFile = CONFIG_FILE, roots = pluginRoots() } = {}) {
  const record = readConfig(configFile).plugins?.[name] ?? null
  const plugin = record ? allowedPlugin(name, record, roots) : checkPlugin(findPlugin(name, roots))
  return { ...describe(plugin), allowed: Boolean(record), configured: record?.settings ?? null }
}

/**
 * Checked first and recorded only when it passes, with the version and the directory of the copy
 * checked, which `send` holds it to. Settings given here are merged over the ones already
 * recorded, so allowing again after an update needs none repeated.
 *
 * @param {string[]} pairs `key=value`, as typed
 */
export function allowPlugin (name, pairs = [], { configFile = CONFIG_FILE, roots = pluginRoots() } = {}) {
  const found = findPlugin(name, roots)
  const { manifest } = readManifest(found)
  const kinds = isRecord(manifest.settings) ? manifest.settings : {}
  const given = {}
  for (const pair of pairs) {
    const at = pair.indexOf('=')
    if (at < 1) throw new SporeError(`"${pair}" is not a setting`, { type: 'PLUGIN_SETTING_INVALID', detail: 'settings are key=value, as cdp=9222' })
    const key = pair.slice(0, at)
    const value = pair.slice(at + 1)
    given[key] = kinds[key] === 'port' && /^[0-9]+$/.test(value) ? Number(value) : value
  }
  const settings = { ...readConfig(configFile).plugins?.[name]?.settings, ...given }
  const plugin = checkPlugin(found, settings)
  setPlugin(name, recordOf(plugin), configFile)
  return { ...describe(plugin), allowed: true, configured: settings }
}

export function disallowPlugin (name, { configFile = CONFIG_FILE } = {}) {
  if (!readConfig(configFile).plugins?.[name]) {
    throw new SporeError(`plugin "${name}" is not allowed`, { type: 'PLUGIN_NOT_ALLOWED', detail: 'spore plugin ls shows which are' })
  }
  unsetPlugin(name, configFile)
  return { name, allowed: false }
}
