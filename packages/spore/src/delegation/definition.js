/**
 * Precursor definitions — `precursors/<name>.cmk` in the top workspace, and `spore.cmk`.
 * Format and rationale: ARCHITECTURE.md, "Precursors".
 *
 * The grammar, the schema and every refusal are `rust/definition`, reached through the
 * addon (`src/native.js`): one implementation for this runtime and a Rust host alike.
 */

import { readFileSync } from 'node:fs'

import { definitionPath } from '../core/spore-dir.js'
import { TOOL_NAMES } from '../core/tool-names.js'
import { native } from '../native.js'
import { SporeError } from '../observability/errors.js'

const LAYOUT = JSON.parse(native.layout())
export const PRECURSOR_DIR = LAYOUT.precursorDir
export const PRECURSOR_EXT = LAYOUT.precursorExt

/** `10m` in milliseconds, or null. */
export function durationMs (v) {
  return native.durationMs(String(v))
}

/** An amount of the limit `dimension` — `rounds`, `cost` or `wall` — as a definition writes one, or null. */
export function limitAmount (dimension, v) {
  return native.limitAmount(dimension, String(v))
}

/** `10MB` in bytes, or null. A bare number is bytes. */
export function sizeBytes (v) {
  return native.sizeBytes(String(v))
}

/**
 * The grammar only: `key: scalar` and `key: [a, b]`, in the order written. Which keys are
 * allowed is the schema's business.
 *
 * @returns {{ fields: Record<string, string|string[]> } | { error: string }}
 */
export function parseFrontmatter (head) {
  return JSON.parse(native.parseFrontmatter(head))
}

/**
 * The frontmatter with `model:` replaced or added, and the plugins added to any it already
 * names. Line by line, so everything else in the file stays as its author wrote it.
 */
export function filledIn (source, { model, plugins, writes = [] }) {
  const end = source.indexOf('\n---', 3)
  const head = source.slice(0, end).split('\n')
  const body = source.slice(end)
  const at = (key) => head.findIndex((line, i) => i > 0 && line.startsWith(`${key}:`))
  if (model) {
    const line = `model: ${model}`
    if (at('model') > 0) head[at('model')] = line
    else head.splice(1, 0, line)
  }
  if (plugins.length) {
    let held = []
    if (at('plugins') > 0) {
      const parsed = parseFrontmatter(head[at('plugins')])
      if (parsed.error) throw new SporeError(`its plugins line ${parsed.error}`, { type: 'DEFINITION_INVALID', detail: 'plugins: [a, b]' })
      held = [].concat(parsed.fields.plugins)
    }
    const line = `plugins: [${[...new Set([...held, ...plugins])].join(', ')}]`
    if (at('plugins') > 0) head[at('plugins')] = line
    else head.push(line)
  }
  if (writes.length) {
    if (at('writes') > 0) throw new SporeError('its definition already writes a directory', { type: 'DEFINITION_INVALID', detail: 'a spore made to work in a directory is given that one grant' })
    head.push(`writes: [${writes.join(', ')}]`)
  }
  return head.join('\n') + body
}

/**
 * A `.cmk` parsed: a root definition by default, a precursor — a cell's definition — with
 * `cell: true`, which is where their rules differ.
 *
 * @returns {object | { error: string }}
 */
export function parseDefinition (source, { knownTools = [], cell = false, seed = false } = {}) {
  return JSON.parse(native.parseDefinition(source, { knownTools: Array.from(knownTools), cell, seed }))
}

/** The `spore.cmk` of the spore at `ws`, parsed: the definition, or `{ error }`. */
export const parsedDefinition = (ws) => parseDefinition(readFileSync(definitionPath(ws), 'utf8'), { knownTools: TOOL_NAMES })

/** The `spore.cmk` of the spore at `ws`, parsed, or `DEFINITION_INVALID` naming the file and what is wrong with it. */
export function sporeDefinition (ws) {
  const definition = parsedDefinition(ws)
  if (definition.error) throw new SporeError(`${definitionPath(ws)} ${definition.error}`, { type: 'DEFINITION_INVALID' })
  return definition
}
