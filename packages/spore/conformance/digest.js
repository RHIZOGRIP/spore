/**
 * What says whether two runs ran the same case: a hash of what the agent is given and what it
 * is judged on, so a case's runs count together across spore releases until the case changes.
 *
 * Given: the staged identity without its `model:` line, since the model is what a run measures,
 * and every file staged into the workspace. Judged on: the messages, the schedule and `expect`.
 * Left out: `reference.md` and `libraries.md`, which every workspace gets and which change with
 * the runtime, and the grader; `run.json` pins both through `spore` and `commit`.
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const RUNTIME_DOCS = new Set(['reference.md', 'libraries.md'])

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Sorted keys, and a RegExp as its source and flags: `JSON.stringify` writes every one as `{}`. */
export function canonical (value) {
  if (value instanceof RegExp) return { $regexp: value.source, flags: value.flags }
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  }
  return value
}

function withoutModel (source) {
  const end = source.indexOf('\n---', 3)
  const head = source.slice(0, end).split('\n').filter((line, i) => i === 0 || !line.startsWith('model:'))
  return head.join('\n') + source.slice(end)
}

function stagedFiles (ws, dir = ws) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return stagedFiles(ws, path)
    const name = relative(ws, path)
    return RUNTIME_DOCS.has(name) ? [] : [[name, sha256(readFileSync(path))]]
  })
}

/** Called after `stage()` and before `openWorkspace()`, which seeds what every workspace gets. */
export function caseDigest ({ ws, cmk }, item) {
  return sha256(JSON.stringify(canonical({
    definition: withoutModel(readFileSync(cmk, 'utf8')),
    files: Object.fromEntries(stagedFiles(ws)),
    messages: item.messages ?? [item.prompt],
    schedule: item.schedule ?? null,
    expect: item.expect
  })))
}
