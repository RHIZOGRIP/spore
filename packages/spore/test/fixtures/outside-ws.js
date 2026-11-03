/**
 * A workspace the sandbox does not already reach.
 *
 * Every other test puts its workspace under `test/` or in `os.tmpdir()`, and `planSpawn`
 * refuses both: `/tmp` because it is granted — the brokers' sockets live there, and
 * confining a child under a directory its parent's ruleset already opens isolates
 * nothing — and the checkout because it holds the shipped definition. A test that
 * launches a real cell has to live somewhere neither covers.
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { definitionWith, outsideRoot } from '../../src/testing.js'

export { outsideRoot }

/** A definition with the `auth` a gate needs, which a host without one never reads. */
export const withAuth = (source) => source.replace(/^---\n/, '---\nauth: tests\n')

/**
 * The same, already holding the shipped definition. `spore run` opens a workspace and no
 * longer makes one — that is `spore define` — so a test driving the real command needs the
 * directory to be a workspace before it starts.
 */
export function outsideWorkspace (name, model = 'anthropic/claude-haiku-4-5') {
  const dir = outsideRoot(name)
  writeFileSync(resolve(dir, 'spore.cmk'), withAuth(definitionWith(model)))
  return dir
}
