/**
 * Finding workspaces in a directory that holds them.
 *
 * A workspace is a directory holding a definition — the same thing `openWorkspace`
 * requires — so one that has never run is found and reported `idle`, which is already a
 * state `stateOf` has.
 *
 * **One level.** A spore is an immediate subdirectory of its home, `<home>/<name>`, and
 * nothing deeper is looked at. There is no recursion to bound, no depth to tune and no
 * directory names to skip: a checkout sitting under a home costs one `existsSync`, and a
 * workspace may be called anything without going missing. With `homeSplit`, every spore is
 * one level further down, `<home>/<end of name>/<name>`, and that is the one level looked at.
 */

import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { DEFINITION_FILE } from '../core/spore-dir.js'

export const isWorkspace = (dir) => existsSync(resolve(dir, DEFINITION_FILE))

/** Every workspace directly inside a directory that holds them. */
export function workspacesIn (dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => resolve(dir, entry.name))
      .filter(isWorkspace)
  } catch {
    return []
  }
}

/** The spores of a home, laid out flat or, with `homeSplit`, one directory further down. */
export function sporesInHome (home, split) {
  if (!split) return workspacesIn(home)
  try {
    return readdirSync(home, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .flatMap(entry => workspacesIn(resolve(home, entry.name)))
  } catch {
    return []
  }
}
