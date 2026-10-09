/**
 * The environment an agent is given — the same list for the root and for a cell, because the
 * question is the same one: a confined agent gets what it needs to run and no
 * credential it could spend with. Environment variables and, below, the libraries
 * its programs may import.
 *
 * Built up rather than filtered down. `{ ...process.env }` handed an agent every
 * provider key its supervisor held, and a denylist of key names goes stale the day
 * a provider is added — so nothing crosses that is not named here. `wsexec` passes
 * this on to everything the agent runs, which makes it the environment of the
 * whole subtree.
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { native } from '../native.js'
import { SporeError } from '../observability/errors.js'

const SPORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Libraries an agent's own programs may import — `rust/workspace`'s `PROVISIONED_MODULES`,
 * and the same list `reference.md` shows the agent. Anything absent is an ordinary
 * dependency of the runtime and no part of what the agent is offered.
 */
export const PROVISIONED_MODULES = Object.freeze(native.provisionedModules())

/**
 * Each declared library linked into `<ws>/node_modules/` by name, since a bare import from
 * `<ws>/data/` never reaches this package. `NODE_PATH` is not the alternative — `require`
 * honours it and ESM `import` ignores it. A declared library that is not installed is a
 * broken install, refused before anything is linked.
 */
export function provisionModules (ws) {
  const answer = JSON.parse(native.provisionModules(ws, SPORE_ROOT))
  if (answer.error) {
    throw new SporeError(answer.error.message, {
      type: answer.error.type,
      detail: answer.error.detail,
      context: { missing: answer.error.missing, ws }
    })
  }
  return answer.linked
}

/** The list is `rust/workspace`'s `PASSED_THROUGH`, shared with the Rust runner. */
export function agentEnv (env) {
  return JSON.parse(native.agentEnv(JSON.stringify(env)))
}
