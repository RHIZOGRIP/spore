/**
 * Precursor definitions — `precursors/<name>.cmk` in the top workspace, and `spore.cmk`.
 * Format and rationale: ARCHITECTURE.md, "Precursors".
 *
 * The grammar, the schema and every refusal are `rust/definition`, reached through the
 * addon (`src/native.js`): one implementation for this runtime and a Rust host alike.
 */

import { native } from '../native.js'

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
 * A `.cmk` parsed: a root definition by default, a precursor — a cell's definition — with
 * `cell: true`, which is where their rules differ.
 *
 * @returns {object | { error: string }}
 */
export function parseDefinition (source, { knownTools = [], cell = false, seed = false } = {}) {
  return JSON.parse(native.parseDefinition(source, { knownTools: Array.from(knownTools), cell, seed }))
}
