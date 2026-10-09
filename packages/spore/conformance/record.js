/**
 * What a run is called and what it says about itself.
 *
 * A row saying 15/17 is not comparable with another one on its own: the two could
 * differ by model, by build, by which commit of the cases graded them. So a run names
 * itself for when it ran and what it ran on, keeps its workspaces and the definitions
 * it generated, and writes down the rest.
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

export const MANIFEST = 'run.json'
export const LATEST = 'latest'

/**
 * `<base>/20260910-1652-anthropic-claude-opus-5`.
 *
 * The model id is slugged rather than used as it is: it holds a `/`, and a run called
 * `anthropic/claude-opus-5` is two directories, one of them shared with every other
 * Anthropic run.
 */
export function runDir (base, { at = new Date(), model }) {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13)
  const slug = String(model).replace(/[^\w.]+/g, '-').replace(/^-+|-+$/g, '')
  return resolve(base, `${stamp}-${slug}`)
}

/** The build that produced a run. `commit` is null in an installed copy, which has no git. */
export function provenance ({ root, model, spore }) {
  let commit = null
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    // Not a checkout. Recorded as unknown rather than guessed at.
  }
  return { model, spore, commit, node: process.version }
}
