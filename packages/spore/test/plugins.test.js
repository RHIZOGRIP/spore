import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { allowPlugin, checkPlugin, containOf, differingDocs, disallowPlugin, installedPlugins, listPlugins, pluginRoots, pluginServices, preparePlugins, showPlugin, upgradeDocs, PLUGIN_READS } from '../src/core/plugins.js'
import { readConfig } from '../src/library/config.js'
import { definitionWith } from '../src/core/identity-defaults.js'
import { openWorkspace } from '../src/core/workspace.js'
import { sporeSocketDir } from '../src/infra/broker-socket.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '.plugins-test')
const MODULES = join(ROOT, 'node_modules')
const WS = join(ROOT, 'ws')
const CONFIG = join(ROOT, 'config', 'config.json')
const roots = [MODULES]
const DOCS = resolve(__dirname, 'fixtures/plugins/docs')

const PRECURSOR = (name) => `---\nname: ${name}\nrounds: [5, 7]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: discard\n---\n\nYou ${name}.\n`

function plugin (packageName, manifest, { works = '^1', files = {}, programs = {} } = {}) {
  const dir = join(MODULES, packageName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: packageName, version: '0.1.0', spore: manifest && (works ? { works, ...manifest } : manifest) }))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  for (const path of Object.keys(programs)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), '#!/bin/sh\necho hi\n')
    chmodSync(join(dir, path), programs[path])
  }
  return installedPlugins(roots).find(p => p.package === packageName)
}

const BROWSER = {
  settings: { cdp: 'port' },
  programs: { SPORE_BROWSER: './bin/browse' },
  env: { BROWSE_CDP: '{settings.cdp}', BROWSE_SESSION: '{name}', BROWSE_SHOTS: '{data}/browser' },
  reference: 'reference.md'
}
const browser = (over = {}, options = {}) => plugin('@rhizogrip/spore-plugin-browser', { ...BROWSER, ...over }, {
  files: { 'reference.md': '# The browser\n' },
  programs: { 'bin/browse': 0o755 },
  ...options
})

// What `allow` records for an installed plugin, for a config built by hand.
const allowed = (name, settings = {}) => {
  const found = installedPlugins(roots).find(p => p.name === name)
  return { settings, version: JSON.parse(readFileSync(join(found.dir, 'package.json'), 'utf8')).version, dir: realpathSync(found.dir) }
}

const useIn = (ws, names) => {
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'spore.cmk'), definitionWith('anthropic/claude-haiku-4-5').replace('\n---', `\nplugins: [${names.join(', ')}]\n---`))
}

const refusal = (fn) => {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error('not refused')
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(MODULES, { recursive: true })
  mkdirSync(dirname(CONFIG), { recursive: true })
})

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('finding plugins', () => {
  it('looks in every node_modules spore is installed under, the global one among them', () => {
    const global = join(ROOT, 'lib/node_modules')
    const cli = join(global, '@rhizogrip/spore-cli/node_modules')
    const core = join(cli, '@rhizogrip/spore')
    mkdirSync(core, { recursive: true })
    expect(pluginRoots(core)).toEqual([cli, global])
  })

  it('finds spore-plugin-<name> packages, scoped or not, and nothing else', () => {
    plugin('spore-plugin-plain', {})
    plugin('@example/spore-plugin-docs', {})
    plugin('@example/other', {})
    plugin('left-pad', {})
    expect(installedPlugins(roots).map(p => [p.name, p.package]).sort()).toEqual([['docs', '@example/spore-plugin-docs'], ['plain', 'spore-plugin-plain']])
  })

  it('refuses a name two packages answer to', () => {
    plugin('spore-plugin-docs', {})
    plugin('@example/spore-plugin-docs', {})
    expect(refusal(() => showPlugin('docs', { configFile: CONFIG, roots })).type).toBe('PLUGIN_AMBIGUOUS')
  })

  it('says where it looked for one that is not there', () => {
    const err = refusal(() => showPlugin('browser', { configFile: CONFIG, roots }))
    expect(err.type).toBe('PLUGIN_NOT_INSTALLED')
    expect(err.detail).toContain(MODULES)
  })
})

describe('checking a plugin', () => {
  it('passes a plugin that ships precursors only', () => {
    const checked = checkPlugin({ name: 'docs', package: 'spore-plugin-docs', dir: DOCS, root: dirname(DOCS) })
    expect(checked.precursors.map(p => p.name)).toEqual(['extract', 'review', 'summarize'])
  })

  it('passes the browser plugin as it ships, and gives each spore a session of its own', () => {
    const dir = join(MODULES, '@rhizogrip/spore-plugin-browser')
    mkdirSync(dir, { recursive: true })
    for (const file of ['package.json', 'reference.md']) copyFileSync(resolve(__dirname, '../../../plugins/browser', file), join(dir, file))
    mkdirSync(join(MODULES, 'agent-browser/bin'), { recursive: true })
    writeFileSync(join(MODULES, 'agent-browser/package.json'), JSON.stringify({ name: 'agent-browser', version: '0.38.1' }))
    writeFileSync(join(MODULES, 'agent-browser/bin/agent-browser-linux-x64'), '#!/bin/sh\n')
    chmodSync(join(MODULES, 'agent-browser/bin/agent-browser-linux-x64'), 0o755)
    useIn(WS, ['browser'])

    const { env } = preparePlugins(WS, { config: { plugins: { browser: allowed('browser', { cdp: 9222 }) } }, roots })

    expect(env).toEqual({
      [PLUGIN_READS]: JSON.stringify([realpathSync(dir), realpathSync(join(MODULES, 'agent-browser'))]),
      SPORE_BROWSER: join(MODULES, 'agent-browser/bin/agent-browser-linux-x64'),
      AGENT_BROWSER_CDP: '9222',
      AGENT_BROWSER_SESSION: 'ws',
      AGENT_BROWSER_PIN_TAB: '1',
      AGENT_BROWSER_SOCKET_DIR: join(sporeSocketDir(WS), 'browser'),
      AGENT_BROWSER_SCREENSHOT_DIR: join(WS, 'data/browser'),
      AGENT_BROWSER_DOWNLOAD_PATH: join(WS, 'data/browser/downloads')
    })
    expect(readFileSync(join(WS, 'plugins/browser.md'), 'utf8')).toMatch(/^# The browser: "\$SPORE_BROWSER" drives/)
  })

  it('passes the ssh plugin as it ships: the agent\'s socket, and an ssh that keeps its files at home', () => {
    const dir = join(MODULES, '@rhizogrip/spore-plugin-ssh')
    mkdirSync(join(dir, 'bin'), { recursive: true })
    for (const file of ['package.json', 'reference.md', 'bin/ssh']) copyFileSync(resolve(__dirname, '../../../plugins/ssh', file), join(dir, file))
    chmodSync(join(dir, 'bin/ssh'), 0o755)
    useIn(WS, ['ssh'])

    const { env } = preparePlugins(WS, { config: { plugins: { ssh: allowed('ssh', { socket: '/run/user/1000/spore-ssh-agent.socket' }) } }, roots })

    expect(env).toEqual({
      [PLUGIN_READS]: JSON.stringify([realpathSync(dir)]),
      SPORE_SSH: join(dir, 'bin/ssh'),
      GIT_SSH: join(dir, 'bin/ssh'),
      SSH_AUTH_SOCK: '/run/user/1000/spore-ssh-agent.socket'
    })
    expect(readFileSync(join(WS, 'plugins/ssh.md'), 'utf8')).toMatch(/^# SSH: keys you can use and never read/)
  })

  it('refuses a package with no manifest, or one it cannot read', () => {
    expect(refusal(() => checkPlugin(plugin('spore-plugin-bare', undefined))).message).toMatch(/has no "spore" manifest/)
    expect(refusal(() => checkPlugin(plugin('spore-plugin-odd', { identity: 'x' }))).message).toMatch(/manifest field spore does not know — identity/)
  })

  it('refuses one that does not say which spore it works with, or not this one', () => {
    expect(refusal(() => checkPlugin(plugin('spore-plugin-a', {}, { works: null }))).message).toMatch(/does not say which spore/)
    expect(refusal(() => checkPlugin(plugin('spore-plugin-b', {}, { works: '^99' }))).type).toBe('PLUGIN_INCOMPATIBLE')
  })

  it('checks the settings the host gives against the ones it declares', () => {
    const found = browser()
    expect(refusal(() => checkPlugin(found, {})).type).toBe('PLUGIN_SETTING_MISSING')
    expect(refusal(() => checkPlugin(found, { cdp: 70000 })).type).toBe('PLUGIN_SETTING_INVALID')
    expect(refusal(() => checkPlugin(found, { cdp: 9222, colour: 'red' })).type).toBe('PLUGIN_SETTING_UNKNOWN')
    expect(checkPlugin(found, { cdp: 9222 }).programs.SPORE_BROWSER).toBe(join(found.dir, 'bin/browse'))
  })

  it('refuses a program that is not executable, or outside the plugin and what it depends on', () => {
    expect(refusal(() => checkPlugin(browser({}, { programs: { 'bin/browse': 0o644 } }))).message).toMatch(/not executable/)

    const elsewhere = join(ROOT, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'browse'), '#!/bin/sh\n')
    chmodSync(join(elsewhere, 'browse'), 0o755)
    const found = browser({}, { programs: {} })
    rmSync(join(found.dir, 'bin', 'browse'))
    symlinkSync(join(elsewhere, 'browse'), join(found.dir, 'bin/browse'))
    expect(refusal(() => checkPlugin(found)).message).toMatch(/outside itself and what it depends on/)
  })

  it('finds a program in a package the plugin depends on', () => {
    const found = browser({ programs: { SPORE_BROWSER: 'engine/bin/run' } }, { programs: {} })
    const pkg = JSON.parse(readFileSync(join(found.dir, 'package.json'), 'utf8'))
    writeFileSync(join(found.dir, 'package.json'), JSON.stringify({ ...pkg, dependencies: { engine: '1.0.0' } }))
    mkdirSync(join(MODULES, 'engine', 'bin'), { recursive: true })
    writeFileSync(join(MODULES, 'engine', 'package.json'), JSON.stringify({ name: 'engine', version: '1.0.0' }))
    writeFileSync(join(MODULES, 'engine', 'bin', 'run'), '#!/bin/sh\n')
    chmodSync(join(MODULES, 'engine', 'bin', 'run'), 0o755)
    expect(checkPlugin(found).programs.SPORE_BROWSER).toBe(join(MODULES, 'engine/bin/run'))
    expect(refusal(() => checkPlugin(browser({ programs: { SPORE_BROWSER: 'absent/bin/run' } }))).message).toMatch(/in absent, which is not installed/)
  })

  it('refuses a variable the runtime sets, and allows its own prefix', () => {
    for (const name of ['HOME', 'PATH', 'SPORE_SPAWN', 'SPORE_OTHER']) {
      expect(refusal(() => checkPlugin(browser({ env: { [name]: 'x' } }))).message).toMatch(new RegExp(`sets ${name}, which it may not`))
    }
    expect(checkPlugin(browser({ env: { SPORE_BROWSER_TABS: 'own' } })).env).toEqual({ SPORE_BROWSER_TABS: 'own' })
    expect(refusal(() => checkPlugin(plugin('spore-plugin-plugin', { env: { [PLUGIN_READS]: '["/"]' } }))).message).toMatch(new RegExp(`sets ${PLUGIN_READS}, which it may not`))
  })

  it('refuses a variable the runtime sets even when its name starts with the plugin\'s own prefix', () => {
    for (const [pkg, name] of [['spore-plugin-socket', 'SPORE_SOCKET_DIR'], ['spore-plugin-cell', 'SPORE_CELL'], ['spore-plugin-model', 'SPORE_MODEL_SOCKET'], ['spore-plugin-plugin', 'SPORE_PLUGIN_ENV']]) {
      expect(refusal(() => checkPlugin(plugin(pkg, { env: { [name]: 'x' } }))).message).toMatch(new RegExp(`sets ${name}, which it may not`))
    }
    expect(refusal(() => checkPlugin(browser({ env: { MOHDEL_MEDIA_ROOTS: '/' } }))).message).toMatch(/sets MOHDEL_MEDIA_ROOTS, which it may not/)
  })

  it('grants the plugin and every package it depends on, as installed, and refuses one missing', () => {
    const found = plugin('spore-plugin-deep', {})
    writeFileSync(join(found.dir, 'package.json'), JSON.stringify({ name: 'spore-plugin-deep', version: '0.1.0', dependencies: { a: '1' }, optionalDependencies: { absent: '1' }, spore: { works: '^1' } }))
    mkdirSync(join(MODULES, 'a'))
    writeFileSync(join(MODULES, 'a/package.json'), JSON.stringify({ name: 'a', dependencies: { b: '1' } }))
    expect(refusal(() => checkPlugin(found)).message).toMatch(/depends on b, which is not installed/)
    mkdirSync(join(MODULES, 'a/node_modules/b'), { recursive: true })
    writeFileSync(join(MODULES, 'a/node_modules/b/package.json'), JSON.stringify({ name: 'b', dependencies: { a: '1' } }))
    expect(checkPlugin(found).reads).toEqual([found.dir, join(MODULES, 'a'), join(MODULES, 'a/node_modules/b')].map(dir => realpathSync(dir)))
  })

  it('leaves out of what the agent reads a package the sandbox grants already, or one inside another it reads', () => {
    const found = plugin('spore-plugin-deep', {})
    writeFileSync(join(found.dir, 'package.json'), JSON.stringify({ name: 'spore-plugin-deep', version: '0.1.0', dependencies: { a: '1', semver: '7' }, spore: { works: '^1' } }))
    mkdirSync(join(found.dir, 'node_modules/a'), { recursive: true })
    writeFileSync(join(found.dir, 'node_modules/a/package.json'), JSON.stringify({ name: 'a' }))
    useIn(WS, ['deep'])

    expect(checkPlugin(found).reads.filter(dir => dir.endsWith('/node_modules/semver'))).toHaveLength(1)
    const { env } = preparePlugins(WS, { config: { plugins: { deep: allowed('deep') } }, roots })
    expect(JSON.parse(env[PLUGIN_READS])).toEqual([realpathSync(found.dir)])
  })

  it('refuses a placeholder it does not fill', () => {
    expect(refusal(() => checkPlugin(browser({ env: { X: '{home}' } }))).message).toMatch(/\{home\}, which spore does not fill/)
    expect(refusal(() => checkPlugin(browser({ env: { X: '{settings.port}' } }))).message).toMatch(/\{settings\.port\}/)
  })

  it('refuses a precursor that does not parse, or is not named as its file', () => {
    const broken = plugin('spore-plugin-p1', { precursors: 'precursors' }, { files: { 'precursors/a.cmk': '---\nname: a\n---\nno limits' } })
    expect(refusal(() => checkPlugin(broken)).message).toMatch(/precursor a\.cmk that does not parse/)
    const misnamed = plugin('spore-plugin-p2', { precursors: 'precursors' }, { files: { 'precursors/a.cmk': PRECURSOR('b') } })
    expect(refusal(() => checkPlugin(misnamed)).message).toMatch(/precursor a\.cmk named b/)
  })

  it('refuses a path outside itself', () => {
    expect(refusal(() => checkPlugin(browser({ reference: '../../elsewhere.md' }))).message).toMatch(/outside itself/)
  })
})

describe('the services a plugin offers', () => {
  const RELAY = { what: 'a relay, each bot reaching its spore', program: './bin/relay.js', instances: { dir: 'relay', ext: '.json', called: 'bot' }, check: ['--check'] }
  const relay = (services) => plugin('spore-plugin-relay', { services }, { files: { 'bin/relay.js': '' } })

  it('are the program the host runs, found in the plugin, and offered without the plugin being allowed', () => {
    const found = relay({ relay: RELAY })
    expect(checkPlugin(found).services).toEqual({ relay: { ...RELAY, program: join(found.dir, 'bin', 'relay.js') } })
    expect(pluginServices(roots)).toEqual({
      services: [{ name: 'relay', ...RELAY, program: join(found.dir, 'bin', 'relay.js'), plugin: 'relay', package: 'spore-plugin-relay', version: '0.1.0', dir: found.dir }],
      problems: []
    })
  })

  it('refuse a service spore could not write a unit for', () => {
    const refused = (service, name = 'relay') => refusal(() => checkPlugin(relay({ [name]: service }))).message
    expect(refused(RELAY, 'Relay')).toMatch(/has a service named "Relay"/)
    expect(refused({ ...RELAY, unit: '[Service]' })).toMatch(/a field spore does not know — unit/)
    expect(refused({ ...RELAY, what: '' })).toMatch(/does not say what it is/)
    expect(refused({ ...RELAY, program: './bin/gone.js' })).toMatch(/names \.\/bin\/gone\.js, which it does not contain/)
    expect(refused({ ...RELAY, program: '../elsewhere.js' })).toMatch(/outside itself/)
    expect(refused({ ...RELAY, instances: { dir: '../up', ext: '.json', called: 'bot' } })).toMatch(/instances spore cannot read/)
    expect(refused({ ...RELAY, check: '--check' })).toMatch(/check is not a list of arguments/)
  })

  it('are a problem to show when the plugin declaring them does not check, and nothing when it declares none', () => {
    plugin('spore-plugin-relay', { services: { relay: RELAY } })
    plugin('spore-plugin-quiet', { programs: { SPORE_QUIET: './bin/gone' } })
    const { services, problems } = pluginServices(roots)
    expect(services).toEqual([])
    expect(problems).toEqual([expect.objectContaining({ plugin: 'relay', problem: expect.stringMatching(/names \.\/bin\/relay\.js, which it does not contain/) })])
  })
})

describe('libraries a plugin offers', () => {
  const library = (name) => {
    mkdirSync(join(MODULES, name), { recursive: true })
    writeFileSync(join(MODULES, name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  }
  const offering = (packageName, modules, dependencies = Object.fromEntries(modules.map(m => [m, '1']))) => {
    const found = plugin(packageName, {})
    writeFileSync(join(found.dir, 'package.json'), JSON.stringify({ name: packageName, version: '0.1.0', dependencies, spore: { works: '^1', modules } }))
    for (const name of Object.keys(dependencies)) library(name)
    return found
  }

  it('are dependencies of the plugin, found where they are installed, and never a provisioned one', () => {
    const found = offering('spore-plugin-pics', ['pixels'])
    expect(checkPlugin(found).modules).toEqual({ pixels: realpathSync(join(MODULES, 'pixels')) })
    expect(refusal(() => checkPlugin(offering('spore-plugin-pics', ['pixels'], {}))).message).toMatch(/offers a module pixels it does not depend on/)
    expect(refusal(() => checkPlugin(offering('spore-plugin-pics', ['luxon']))).message).toMatch(/offers luxon, which every spore is already given/)
    expect(refusal(() => checkPlugin(offering('spore-plugin-pics', 'pixels', { pixels: '1' }))).message).toMatch(/modules that are not a list/)
  })

  it('are linked into the workspace for a spore that uses the plugin, and unlinked once it does not', () => {
    offering('spore-plugin-pics', ['pixels', '@scope/frames'])
    useIn(WS, ['pics'])
    const config = { plugins: { pics: allowed('pics') } }
    mkdirSync(join(WS, 'node_modules/kept'), { recursive: true })
    symlinkSync(join(MODULES, 'pixels'), join(WS, 'node_modules/luxon'))

    preparePlugins(WS, { config, roots })
    expect(realpathSync(join(WS, 'node_modules/pixels'))).toBe(realpathSync(join(MODULES, 'pixels')))
    expect(realpathSync(join(WS, 'node_modules/@scope/frames'))).toBe(realpathSync(join(MODULES, '@scope/frames')))

    writeFileSync(join(WS, 'spore.cmk'), definitionWith('anthropic/claude-haiku-4-5'))
    preparePlugins(WS, { config, roots })
    expect(readdirSync(join(WS, 'node_modules')).sort()).toEqual(['@scope', 'kept', 'luxon'])
    expect(readdirSync(join(WS, 'node_modules/@scope'))).toEqual([])
  })

  it('are refused from two plugins a spore uses together', () => {
    offering('spore-plugin-pics', ['pixels'])
    offering('spore-plugin-more', ['pixels'])
    useIn(WS, ['pics', 'more'])
    const config = { plugins: { pics: allowed('pics'), more: allowed('more') } }
    expect(refusal(() => preparePlugins(WS, { config, roots }))).toMatchObject({ type: 'PLUGIN_CONFLICT', message: 'plugins pics and more both offer pixels' })
  })
})

describe('endpoints a plugin describes', () => {
  const WEB = { url: 'https://search.example/api', headers: { 'x-key': '${WEB_KEY}' } } // eslint-disable-line no-template-curly-in-string

  it('are described as the host describes one, and refused without an http url or a usable name', () => {
    expect(checkPlugin(plugin('spore-plugin-web', { sources: { web: WEB } })).sources).toEqual({ web: WEB })
    expect(refusal(() => checkPlugin(plugin('spore-plugin-web', { sources: { web: { url: 'ftp://x' } } }))).message).toMatch(/source web with no http:\/\/ or https:\/\/ url/)
    expect(refusal(() => checkPlugin(plugin('spore-plugin-web', { sources: { Web: WEB } }))).message).toMatch(/source named "Web"/)
  })

  it('send the calling spore\'s name where a header holds {name}, and refuse it anywhere else', () => {
    const named = { ...WEB, headers: { ...WEB.headers, 'x-spore': '{name}' } }
    expect(checkPlugin(plugin('spore-plugin-web', { sources: { web: named } })).sources).toEqual({ web: named })
    expect(refusal(() => checkPlugin(plugin('spore-plugin-web', { sources: { web: { ...WEB, headers: { 'x-spore': '{ws}' } } } }))).message).toMatch(/source web with \{ws\} in its x-spore header/)
    expect(refusal(() => checkPlugin(plugin('spore-plugin-web', { sources: { web: { ...WEB, query: { spore: '{name}' } } } }))).message).toMatch(/source web with \{name\} in its query/)
  })

  it('go to the runner for a spore that uses the plugin, never into its environment', () => {
    plugin('spore-plugin-web', { sources: { web: WEB } })
    useIn(WS, ['web'])
    const prepared = preparePlugins(WS, { config: { plugins: { web: allowed('web') } }, roots })
    expect(prepared.sources).toEqual({ web: WEB })
    expect(JSON.stringify(prepared.env)).not.toMatch(/search\.example|WEB_KEY/)
  })

  it('are refused from two plugins a spore uses together under one name', () => {
    plugin('spore-plugin-web', { sources: { web: WEB } })
    plugin('spore-plugin-other', { sources: { web: WEB } })
    useIn(WS, ['web', 'other'])
    const config = { plugins: { web: allowed('web'), other: allowed('other') } }
    expect(refusal(() => preparePlugins(WS, { config, roots }))).toMatchObject({ type: 'PLUGIN_CONFLICT', message: 'plugins web and other both describe the source web' })
  })
})

describe('enabling one', () => {
  it('records it with its settings, merged over what was recorded, and forgets it on disable', () => {
    browser()
    expect(refusal(() => allowPlugin('browser', [], { configFile: CONFIG, roots })).type).toBe('PLUGIN_SETTING_MISSING')
    expect(existsSync(CONFIG)).toBe(false)

    allowPlugin('browser', ['cdp=9222'], { configFile: CONFIG, roots })
    expect(readConfig(CONFIG).plugins).toEqual({ browser: allowed('browser', { cdp: 9222 }) })
    allowPlugin('browser', [], { configFile: CONFIG, roots })
    expect(readConfig(CONFIG).plugins).toEqual({ browser: allowed('browser', { cdp: 9222 }) })

    expect(listPlugins({ configFile: CONFIG, roots }).plugins.map(p => [p.name, p.allowed, p.problem])).toEqual([['browser', true, null]])
    disallowPlugin('browser', { configFile: CONFIG })
    expect(readConfig(CONFIG).plugins).toEqual({})
    expect(refusal(() => disallowPlugin('browser', { configFile: CONFIG })).type).toBe('PLUGIN_NOT_ALLOWED')
  })

  it('holds a turn to the copy that was allowed, until it is allowed again', () => {
    const found = browser()
    allowPlugin('browser', ['cdp=9222'], { configFile: CONFIG, roots })
    useIn(WS, ['browser'])
    expect(preparePlugins(WS, { config: readConfig(CONFIG), roots }).plugins).toHaveLength(1)

    const pkg = JSON.parse(readFileSync(join(found.dir, 'package.json'), 'utf8'))
    writeFileSync(join(found.dir, 'package.json'), JSON.stringify({ ...pkg, version: '0.2.0' }))
    const changed = refusal(() => preparePlugins(WS, { config: readConfig(CONFIG), roots }))
    expect(changed.type).toBe('PLUGIN_CHANGED')
    expect(changed.message).toMatch(/0\.1\.0 at .* now 0\.2\.0/)
    expect(listPlugins({ configFile: CONFIG, roots }).plugins[0].problem).toMatch(/changed since it was allowed/)

    allowPlugin('browser', [], { configFile: CONFIG, roots })
    expect(preparePlugins(WS, { config: readConfig(CONFIG), roots }).plugins[0].version).toBe('0.2.0')
  })

  it('lists what is wrong with each, and what is allowed but gone', () => {
    plugin('spore-plugin-old', {}, { works: '^2' })
    writeFileSync(CONFIG, JSON.stringify({ plugins: { gone: { settings: {}, version: '0.1.0', dir: '/nowhere' } } }))
    const listed = listPlugins({ configFile: CONFIG, roots })
    expect(listed.plugins[0].problem).toMatch(/does not work with this spore/)
    expect(listed.missing).toEqual(['gone'])
  })
})

describe('a turn of a spore that uses plugins', () => {
  const config = (plugins) => ({ plugins })

  it('fills in its environment, and copies in its reference and precursors once', () => {
    browser()
    plugin('@example/spore-plugin-docs', { precursors: 'precursors' }, { files: { 'precursors/extract.cmk': PRECURSOR('extract') } })
    useIn(WS, ['browser', 'docs'])
    mkdirSync(join(WS, 'precursors'))
    writeFileSync(join(WS, 'precursors/extract.cmk'), 'mine')

    const { env } = preparePlugins(WS, { config: config({ browser: allowed('browser', { cdp: 9222 }), docs: allowed('docs') }), roots })
    expect(env).toEqual({
      [PLUGIN_READS]: JSON.stringify([allowed('browser').dir, allowed('docs').dir]),
      SPORE_BROWSER: join(MODULES, '@rhizogrip/spore-plugin-browser/bin/browse'),
      BROWSE_CDP: '9222',
      BROWSE_SESSION: 'ws',
      BROWSE_SHOTS: join(WS, 'data/browser')
    })
    expect(readFileSync(join(WS, 'plugins/browser.md'), 'utf8')).toBe('# The browser\n')
    expect(readFileSync(join(WS, 'precursors/extract.cmk'), 'utf8')).toBe('mine')
  })

  it('refuses a plugin that is not allowed, and two that set the same variable', () => {
    browser()
    plugin('spore-plugin-shots', { env: { BROWSE_SHOTS: '{data}' } })
    useIn(WS, ['browser', 'shots'])
    expect(refusal(() => preparePlugins(WS, { config: config({ browser: allowed('browser', { cdp: 9222 }) }), roots })).type).toBe('PLUGIN_NOT_ALLOWED')
    expect(refusal(() => preparePlugins(WS, { config: config({ browser: allowed('browser', { cdp: 9222 }), shots: allowed('shots') }), roots })).type).toBe('PLUGIN_CONFLICT')
  })

  it('fills what a plugin keeps in view of a contained spore, and refuses two that hide the same place', () => {
    const KEEPING = { settings: { dir: 'text' }, contain: { hide: '{settings.dir}', keep: '{settings.dir}/spores/{name}', missing: 'no rules for {name}' } }
    plugin('spore-plugin-gate', KEEPING)
    plugin('spore-plugin-other', KEEPING)
    const dir = '/run/user/1000/sluice'
    const settings = { config: config({ gate: allowed('gate', { dir }) }), roots }
    const expected = [{ plugin: 'gate', hide: dir, keep: `${dir}/spores/ws`, missing: 'no rules for ws' }]
    useIn(WS, ['gate'])
    expect(preparePlugins(WS, settings).contain).toEqual(expected)
    expect(containOf(WS, settings)).toEqual(expected)

    useIn(WS, ['gate', 'other'])
    const both = config({ gate: allowed('gate', { dir }), other: allowed('other', { dir: `${dir}/inner` }) })
    expect(refusal(() => preparePlugins(WS, { config: both, roots })).type).toBe('PLUGIN_CONFLICT')

    useIn(WS, ['gate'])
    expect(refusal(() => containOf(WS, { config: config({ gate: allowed('gate', { dir: 'relative' }) }), roots })).type).toBe('PLUGIN_CONTAIN_INVALID')
  })

  it('refuses a contain it cannot read', () => {
    const partial = plugin('spore-plugin-partial', { contain: { hide: '/x' } })
    expect(refusal(() => checkPlugin(partial)).message).toMatch(/has a contain spore cannot read/)
    const unfilled = plugin('spore-plugin-unfilled', { contain: { hide: '{nope}', keep: '{nope}/a', missing: 'x' } })
    expect(refusal(() => checkPlugin(unfilled)).message).toMatch(/sets contain\.hide with \{nope\}/)
  })

  it('gives nothing to one whose definition does not parse, which the agent refuses', () => {
    mkdirSync(WS)
    writeFileSync(join(WS, 'spore.cmk'), 'no frontmatter')
    expect(preparePlugins(WS, { config: config({}), roots })).toEqual({ env: {}, plugins: [], sources: {}, contain: [] })
  })
})

describe('documentation that differs from what is installed', () => {
  it('names each root doc that differs, and upgrade replaces only those', () => {
    browser()
    useIn(WS, ['browser'])
    const settings = { config: config({ browser: allowed('browser', { cdp: 9222 }) }), roots }
    expect(openWorkspace(WS, { allowGranted: true }).error).toBeUndefined()
    preparePlugins(WS, settings)
    expect(differingDocs(WS, settings)).toEqual([])

    writeFileSync(join(WS, 'reference.md'), 'edited')
    writeFileSync(join(MODULES, '@rhizogrip/spore-plugin-browser/reference.md'), '# The browser, newer\n')
    expect(differingDocs(WS, settings).map(d => d.file)).toEqual(['reference.md', 'plugins/browser.md'])

    const libraries = readFileSync(join(WS, 'libraries.md'))
    expect(upgradeDocs(WS, settings).replaced).toEqual(['reference.md', 'plugins/browser.md'])
    expect(readFileSync(join(WS, 'plugins/browser.md'), 'utf8')).toBe('# The browser, newer\n')
    expect(readFileSync(join(WS, 'libraries.md')).equals(libraries)).toBe(true)
    expect(readdirSync(WS).filter(f => f.startsWith('.reference.md.'))).toEqual([])
    expect(readdirSync(join(WS, 'plugins'))).toEqual(['browser.md'])
    expect(differingDocs(WS, settings)).toEqual([])
  })

  it('leaves out a plugin that is not allowed', () => {
    browser()
    useIn(WS, ['browser'])
    mkdirSync(join(WS, 'plugins'))
    writeFileSync(join(WS, 'plugins/browser.md'), 'old')
    expect(differingDocs(WS, { config: config({}), roots })).toEqual([])
    expect(readdirSync(join(WS, 'plugins'))).toEqual(['browser.md'])
  })

  function config (plugins) {
    return { plugins }
  }
})
