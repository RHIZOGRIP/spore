/**
 * `mo` comes inside spore for spore's own use, and npm does not put it on PATH. A message naming a
 * `mo` command says how to install it where it is missing, at the mohdel spore pins, since the two
 * share one catalog.
 */

import { accessSync, constants, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, join } from 'node:path'

const MO_COMMAND = /(?:^|[\s"'`(])mo (?:chatgpt|curate|ls|model|onboard|providers)\b/

function runnable (path) {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const moOnPath = () => (process.env.PATH ?? '').split(delimiter).some(dir => runnable(join(dir, 'mo')))

/** What to install, when `text` names a `mo` command and `mo` is not on PATH; null otherwise. */
export function moHint (text) {
  if (!MO_COMMAND.test(text) || moOnPath()) return null
  const { mohdel } = createRequire(import.meta.url)('@rhizogrip/spore/package.json').dependencies
  return `mo is a separate install: npm install -g mohdel@${mohdel}`
}

export function withMoHint (text) {
  const hint = moHint(text)
  return hint ? `${text} — ${hint}` : text
}
