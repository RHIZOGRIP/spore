/**
 * What a spore's runner starts with, whoever starts it: the environment it was launched with,
 * `environment` beside `config.json` read again for what it was launched without, so a variable
 * set there since reaches the next turn,
 * and none of the secrets the host's services keep — a webhook's, an API caller's, an approval
 * hook's, a bot's — unless a source the runner may fill names one. The agent's own environment is
 * an allowlist the runner builds; this is what the runner and a cell's supervisor hold.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { API_FILE, CONFIG_FILE, HOOKS_FILE, MEMORY_FILE, SOURCES_FILE, loadEnvironment, readConfig } from '../library/config.js'
import { pluginRoots, pluginServices } from './plugins.js'
import { variablesIn } from './variables.js'

const textOf = (path) => existsSync(path) ? readFileSync(path, 'utf8') : ''

/**
 * Every variable a service of the host keeps a secret in: those `hooks.json`, `api.json` and
 * `config.json`'s `approvals` name, and those in each file of every plugin service run once per
 * file (`instances`).
 */
export function serviceSecrets (configFile = CONFIG_FILE, { roots = pluginRoots() } = {}) {
  const dir = dirname(configFile)
  const texts = [textOf(join(dir, HOOKS_FILE)), textOf(join(dir, API_FILE)), JSON.stringify(readConfig(configFile).approvals ?? {})]
  for (const { instances } of pluginServices(roots).services) {
    if (!instances) continue
    const at = join(dir, instances.dir)
    if (!existsSync(at)) continue
    for (const file of readdirSync(at)) {
      if (file.endsWith(instances.ext)) texts.push(textOf(join(at, file)))
    }
  }
  return new Set(texts.flatMap(variablesIn))
}

/** `sources` are the sources of the spore's plugins, as `preparePlugins` answers them: what they name is kept. */
export function turnEnv (env, { configFile = CONFIG_FILE, sources = {}, roots = pluginRoots() } = {}) {
  const fresh = { ...env }
  loadEnvironment(configFile, fresh)
  const dir = dirname(configFile)
  const named = new Set([textOf(join(dir, SOURCES_FILE)), textOf(join(dir, MEMORY_FILE)), JSON.stringify(sources)].flatMap(variablesIn))
  for (const variable of serviceSecrets(configFile, { roots })) {
    if (!named.has(variable)) delete fresh[variable]
  }
  return fresh
}
