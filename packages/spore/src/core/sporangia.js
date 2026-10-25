/**
 * Sporangia: what spores are made from. A sporangium is laid out as a spore is, with none of what
 * running makes — no state, no trail, no inbox — so making a spore from one is copying its tree.
 *
 * Every spore is made the same way: the default sporangium, then the chosen one over it, file by
 * file, so a sporangium carries only what it changes or adds. Each is the package's copy, then the
 * operator's in `sporangia/<name>/` beside `config.json`, the later of each pair winning.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SporeError } from '../observability/errors.js'
import { DEFINITION_FILE } from './spore-dir.js'
import { NAMES } from './names.js'

export const SPORANGIA_DIR = 'sporangia'
export const DEFAULT_SPORANGIUM = 'default'
export const SPORANGIUM_RECORD = 'sporangium.json'
export const SHIPPED_SPORANGIA = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', SPORANGIA_DIR)
export const DEFAULT_DEFINITION_PATH = join(SHIPPED_SPORANGIA, DEFAULT_SPORANGIUM, DEFINITION_FILE)

export const operatorSporangia = (configFile) => resolve(dirname(configFile), SPORANGIA_DIR)

function filesUnder (dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true })
    .map(entry => join(dir, entry))
    .filter(path => statSync(path).isFile())
    .map(path => relative(dir, path))
}

export function knownSporangia ({ configFile = null } = {}) {
  const names = new Set()
  for (const root of [SHIPPED_SPORANGIA, ...(configFile ? [operatorSporangia(configFile)] : [])]) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root)) if (statSync(join(root, entry)).isDirectory()) names.add(entry)
  }
  return [...names].sort()
}

/**
 * What a spore made from `name` is given, as a map from its path in the workspace to the file it
 * is copied from. `configFile` adds the operator's sporangia; without it, only the package's are
 * read, which is what a confined process can reach.
 */
export function sporangiumTree (name, { configFile = null } = {}) {
  if (!NAMES.sporangium.pattern.test(name)) {
    throw new SporeError(`"${name}" cannot be a sporangium's name`, { type: 'SPORANGIUM_UNKNOWN', detail: NAMES.sporangium.says })
  }
  const dirsOf = (one) => [join(SHIPPED_SPORANGIA, one), ...(configFile ? [join(operatorSporangia(configFile), one)] : [])]
  const own = dirsOf(name).filter(dir => existsSync(dir))
  if (!own.length) {
    throw new SporeError(`there is no sporangium "${name}"`, {
      type: 'SPORANGIUM_UNKNOWN',
      detail: `the sporangia are ${knownSporangia({ configFile }).join(', ')}`
    })
  }
  if (name !== DEFAULT_SPORANGIUM && !own.some(dir => existsSync(join(dir, DEFINITION_FILE)))) {
    throw new SporeError(`sporangium "${name}" has no ${DEFINITION_FILE}`, {
      type: 'SPORANGIUM_INVALID',
      detail: `a sporangium says what the spores made from it are: ${own.map(dir => join(dir, DEFINITION_FILE)).join(' or ')}`
    })
  }
  const layers = name === DEFAULT_SPORANGIUM ? dirsOf(DEFAULT_SPORANGIUM) : [...dirsOf(DEFAULT_SPORANGIUM), ...dirsOf(name)]
  const tree = new Map()
  for (const dir of layers) for (const file of filesUnder(dir)) tree.set(file, join(dir, file))
  return tree
}

/**
 * What the package alone gives a spore made from `name`: what a confined process restores a
 * missing root document from, since it cannot read the operator's sporangia. A sporangium only
 * the operator has is not in the package, so its spores are restored from the package's default.
 */
export function shippedTree (name) {
  return sporangiumTree(existsSync(join(SHIPPED_SPORANGIA, name)) ? name : DEFAULT_SPORANGIUM)
}

/** The sporangium a workspace was made from. One made without one — a cell, or one defined from a file — is of the default sporangium. */
export function sporangiumOf (ws) {
  const record = join(ws, SPORANGIUM_RECORD)
  if (!existsSync(record)) return DEFAULT_SPORANGIUM
  return JSON.parse(readFileSync(record, 'utf8')).sporangium
}

export function recordSporangium (ws, name) {
  writeFileSync(join(ws, SPORANGIUM_RECORD), JSON.stringify({ sporangium: name }) + '\n')
}
