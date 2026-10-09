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
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { definitionWith, outsideRoot as outsideRootIn } from '../../src/testing.js'

// Beside the checkout rather than under it, which is where this repo already puts
// workspaces that have to be outside both. `$HOME` looks like the obvious answer and
// is not: it is commonly mounted `noexec`, and a precursor's enzyme is a program
// the enzyme broker has to be able to run.
const base = () => process.env.SPORE_TEST_DIR ||
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../tmp/spore-tests')

export const outsideRoot = (name) => outsideRootIn(name, base())

/**
 * The same, already holding the shipped definition. `spore run` opens a workspace and no
 * longer makes one — that is `spore define` — so a test driving the real command needs the
 * directory to be a workspace before it starts.
 */
export function outsideWorkspace (name, model = 'anthropic/claude-haiku-4-5') {
  const dir = outsideRoot(name)
  writeFileSync(resolve(dir, 'spore.cmk'), definitionWith(model))
  return dir
}
