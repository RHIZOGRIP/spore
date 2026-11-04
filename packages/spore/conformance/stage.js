/**
 * Laying out one case: its fixtures, its precursor, and an identity granting only the
 * tools the case is about — a tool it does not name is a tool it cannot accidentally
 * pass with. A case of the identity tier gets a shipped sporangium instead, laid out as
 * `spore define` lays it out, so what it grades is the prompt spore ships.
 *
 * Separate from the runner so the whole layout can be checked without calling a model.
 */

import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { filledIn } from '../src/delegation/definition.js'
import { DEFINITION_FILE } from '../src/core/spore-dir.js'
import { recordSporangium, sporangiumTree } from '../src/core/sporangia.js'
import { caseLimits } from './cases.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const BOUNDED = ['rounds', 'cost', 'wall']

const bounded = (source, limits) => {
  const end = source.indexOf('\n---', 3)
  const head = source.slice(0, end).split('\n')
  for (const key of BOUNDED) {
    const at = head.findIndex((line, i) => i > 0 && line.startsWith(`${key}:`))
    if (at < 0) throw new Error(`the shipped identity has no ${key} line for the case to bound`)
    head[at] = `${key}: [${limits[key].join(', ')}]`
  }
  return head.join('\n') + source.slice(end)
}

export function stage (root, item, model, limits = caseLimits(item)) {
  const ws = resolve(root, 'cases', item.id)
  mkdirSync(resolve(ws, 'data'), { recursive: true })

  const shipped = item.identity ? sporangiumTree(item.identity) : null
  if (shipped) {
    recordSporangium(ws, item.identity)
    for (const [file, from] of shipped) {
      if (file === DEFINITION_FILE) continue
      mkdirSync(dirname(resolve(ws, file)), { recursive: true })
      copyFileSync(from, resolve(ws, file))
    }
  }

  for (const [path, body] of Object.entries(item.files || {})) {
    mkdirSync(dirname(resolve(ws, path)), { recursive: true })
    writeFileSync(resolve(ws, path), body)
  }
  for (const [dir, files] of Object.entries(item.parts || {})) {
    mkdirSync(resolve(ws, dir, 'data'), { recursive: true })
    for (const [name, body] of Object.entries(files)) writeFileSync(resolve(ws, dir, name), body)
  }
  if (item.precursor) {
    mkdirSync(resolve(ws, 'precursors'), { recursive: true })
    copyFileSync(resolve(HERE, 'precursors', `${item.precursor}.cmk`), resolve(ws, 'precursors', `${item.precursor}.cmk`))
  }
  if (item.enzyme) {
    mkdirSync(resolve(ws, 'data', 'tools'), { recursive: true })
    const dest = resolve(ws, 'data', 'tools', 'shout.mjs')
    copyFileSync(resolve(HERE, 'tools', 'shout.mjs'), dest)
    chmodSync(dest, 0o755)
  }

  const cmk = resolve(root, `${item.id}.cmk`)
  if (shipped) {
    // The run's model and the case's limits, so a run stays as cheap and as bounded as
    // the rest; the tools and the body stay as shipped.
    writeFileSync(cmk, bounded(filledIn(readFileSync(shipped.get(DEFINITION_FILE), 'utf8'), { model, plugins: [] }), limits))
    return { ws, cmk }
  }

  // One identity per case, granting only what the case is about: a tool the case does
  // not name is a tool it cannot accidentally pass with.
  writeFileSync(cmk, [
    '---',
    `name: ${item.id}`,
    // The run chooses the model — that is what this suite asks about — and writes it into
    // each case, because a definition says what it runs on.
    `model: ${model}`,
    `tools: [${item.grants.join(', ')}]`,
    `rounds: [${limits.rounds.join(', ')}]`,
    `cost: [${limits.cost.join(', ')}]`,
    `wall: [${limits.wall.join(', ')}]`,
    ...(item.definition || []),
    '---',
    '',
    'You are being checked against one small task. Do exactly what it asks and stop.',
    'Where it names a file, that file is the answer and its contents must be exactly what',
    'was asked for — no heading, no explanation, no trailing commentary. The check reads it',
    'in your workspace, at the path the task names.',
    ''
  ].join('\n'))
  return { ws, cmk }
}
