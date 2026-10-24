/**
 * The default definition — the default sporangium's `spore.cmk` in the package, so a provided
 * definition and the default one go through the same parse.
 *
 * Byte-stable on purpose: no interpolation, no timestamps, no workspace paths.
 * It shares one cache breakpoint with `rules`, so per-call content here
 * would force a fresh prefix write every turn. Anything that changes per call
 * belongs in the turn's own message instead (ARCHITECTURE §Prompt caching).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { TOOL_NAMES } from '../core/tool-names.js'
import { parseDefinition } from '../delegation/definition.js'
import { DEFAULT_SPORANGIUM, SHIPPED_SPORANGIA } from './sporangia.js'
import { DEFINITION_FILE } from './spore-dir.js'

export const DEFAULT_DEFINITION_PATH = join(SHIPPED_SPORANGIA, DEFAULT_SPORANGIUM, DEFINITION_FILE)

// A seed, not a definition in use: it names no model, because a model id shipped in a package
// goes stale against a catalog that is live.
const parsed = parseDefinition(readFileSync(DEFAULT_DEFINITION_PATH, 'utf8'), { knownTools: TOOL_NAMES, seed: true })
if (parsed.error) throw new Error(`${DEFAULT_DEFINITION_PATH} ${parsed.error} — the shipped default must parse`)

/**
 * The shipped definition with a model written into it. A `.cmk` says what an agent runs
 * on, and this file cannot: a model id baked into a package goes stale against a catalog
 * that is live, and would quietly change what everyone's spores are on an upgrade. So the
 * seed carries the hole and whoever cuts from it fills it.
 */
export const definitionWith = (model) => withModel(readFileSync(DEFAULT_DEFINITION_PATH, 'utf8'), model)

const withModel = (source, model) => {
  const at = source.indexOf('\n', source.indexOf('---') + 3)
  return `${source.slice(0, at)}\nmodel: ${model}${source.slice(at)}`
}
