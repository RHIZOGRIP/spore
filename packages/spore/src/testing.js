/**
 * `@rhizogrip/spore/testing`: what a test of an application against spore needs and the
 * library does not offer — workspace records written as a turn would leave them, the lock a
 * runner holds, the shipped definition under a model of the test's choosing, and a directory
 * the sandbox does not already reach. Never for production code: a record written here is one
 * no turn made.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

import { grantedPathContaining } from './isolation/sandbox.js'

export { appendTurn, acquireLock, releaseLock } from './core/spore-dir.js'
export { definitionWith } from './core/identity-defaults.js'

/**
 * A fresh directory under `base` that no sandbox grant covers, as a cell's workspace must be:
 * `/tmp` is granted and spore's checkout is the runtime's tree. Refused loudly rather than
 * skipped, since a confinement test run somewhere already open tests nothing.
 */
export function outsideRoot (name, base = process.env.SPORE_TEST_DIR) {
  if (!base) throw new Error('outsideRoot needs a directory outside spore\'s checkout and outside /tmp — set SPORE_TEST_DIR or pass one')
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(resolve(base, name + '-'))
  const granted = grantedPathContaining(dir)
  if (granted) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`${dir} is inside ${granted}, where a cell is refused — point SPORE_TEST_DIR at a directory outside spore's checkout and outside /tmp`)
  }
  return dir
}
