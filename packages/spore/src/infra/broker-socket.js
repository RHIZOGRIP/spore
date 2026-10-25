/** Where a broker socket goes. */

import { native } from '../native.js'
import { SporeError } from '../observability/errors.js'

/** The directory a spore's sockets go in, which its runner makes and its agent alone may write. */
export const sporeSocketDir = (ws) => native.sporeSocketDir(ws)

/** The rule is `rust/workspace`'s, shared with the Rust runner. */
export function brokerSocketPath (kind) {
  const built = JSON.parse(native.brokerSocketPath(kind))
  if (built.error) throw new SporeError(built.error.message, { type: built.error.type, detail: built.error.detail })
  return built.path
}
