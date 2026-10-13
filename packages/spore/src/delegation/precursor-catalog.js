/**
 * Which precursors a workspace has, and how the agent is told about them.
 * Contract: ARCHITECTURE.md, "Precursors".
 */

import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { TOOL_NAMES } from '../core/tool-names.js'
import { shippedTree, sporangiumOf } from '../core/sporangia.js'
import { PRECURSOR_DIR, PRECURSOR_EXT, parseDefinition } from './definition.js'

const README = 'README.md'
const SUMMARY_CHARS = 110

/**
 * Copies into a directory the agent writes, from a process it does not confine, so any entry
 * already there — a link included, dangling or not — is the agent's and is never written
 * through.
 */
export function copyAbsent (from, to) {
  if (lstatSync(to, { throwIfNoEntry: false })) return false
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(from, to, constants.COPYFILE_EXCL)
  return true
}

export function seedPrecursors (workspace) {
  const target = resolve(workspace, PRECURSOR_DIR)
  mkdirSync(target, { recursive: true })
  const from = shippedTree(sporangiumOf(workspace)).get(join(PRECURSOR_DIR, README))
  return copyAbsent(from, resolve(target, README)) ? [README] : []
}

export function describePrecursors (workspace) {
  const dir = resolve(workspace, PRECURSOR_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith(PRECURSOR_EXT))
    .sort()
    .map(file => {
      const name = file.slice(0, -PRECURSOR_EXT.length)
      let source
      try {
        source = readFileSync(resolve(dir, file), 'utf8')
      } catch (e) {
        return { name, error: `cannot be read — ${e.code || e.message}` }
      }
      const parsed = parseDefinition(source, { knownTools: TOOL_NAMES, cell: true })
      if (parsed.error) return { name, error: parsed.error }
      const first = parsed.identity.split('\n').find(line => line.trim()) || ''
      return {
        name,
        tools: parsed.tools,
        model: parsed.model ?? null,
        summary: first.length > SUMMARY_CHARS ? first.slice(0, SUMMARY_CHARS - 1) + '…' : first
      }
    })
}

/**
 * The models a precursor's `model:` may name, from the spore's `cell-models`; with none, every
 * sub-agent runs on the spore's own model and nothing is said.
 */
export function cellModelRules (cellModels, model) {
  if (!cellModels.length) return ''
  return [
    `Models a sub-agent can run on, named by model: in its precursor — one naming none runs on yours, ${model}:`,
    ...cellModels.map(named => `- ${named.name}: ${named.model}`),
    'Any other name is refused when the sub-agent is spawned.'
  ].join('\n')
}

export function precursorRules (precursors, dream = null) {
  if (!precursors.length) return ''
  const lines = precursors.map(p => p.error
    ? `- ${p.name} (${PRECURSOR_DIR}/${p.name}${PRECURSOR_EXT}) — unusable until fixed: ${p.error}`
    : p.name === dream
      ? `- ${p.name} (${PRECURSOR_DIR}/${p.name}${PRECURSOR_EXT}) — your dream: the runtime runs it while you are idle, never --precursor`
      : `- ${p.name} (${PRECURSOR_DIR}/${p.name}${PRECURSOR_EXT}) — ${p.summary} (tools: ${p.tools.length ? p.tools.join(', ') : 'none'}${p.model ? `; model: ${p.model}` : ''})`)
  return [
    'Sub-agents you can spawn, named by --precursor <name>:',
    ...lines,
    `Read one to see exactly what it tells its sub-agent. To write another, the format is in ${PRECURSOR_DIR}/README.md.`
  ].join('\n')
}
