/**
 * The libraries an agent's programs may import, the same for the root and for a cell. The
 * variables it is given are `PASSED_THROUGH` in `rust/workspace`, which the runner and
 * `spore-spawn` build its environment from.
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
