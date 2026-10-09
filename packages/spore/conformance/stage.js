/**
 * Laying out one case: its fixtures, its precursor, and an identity granting only the
 * tools the case is about — a tool it does not name is a tool it cannot accidentally
 * pass with.
 *
 * Separate from the runner so the whole layout can be checked without calling a model.
 */

import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { caseLimits } from './cases.js'

const HERE = dirname(fileURLToPath(import.meta.url))

export function stage (MYC, item, model, limits = caseLimits(item)) {
  const ws = resolve(MYC, 'cases', item.id)
  mkdirSync(resolve(ws, 'data'), { recursive: true })

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

  // One identity per case, granting only what the case is about: a tool the case does
  // not name is a tool it cannot accidentally pass with.
  const cmk = resolve(MYC, `${item.id}.cmk`)
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
    'was asked for — no heading, no explanation, no trailing commentary.',
    ''
  ].join('\n'))
  return { ws, cmk }
}
