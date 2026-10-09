/**
 * Where a broker socket goes.
 *
 * `/run/user/<uid>` is the natural home and Landlock grants `/run` read-only —
 * measured EACCES on both the mkdir and the bind. `/tmp` is the one path
 * `sandbox()` always grants read-write, so it is the only place a confined host
 * can bind one. The directory is 0700, which is the protection `/run/user/<uid>`
 * was giving us.
 *
 * **`/tmp` literally, not `os.tmpdir()`.** The runtime points `TMPDIR` at a scratch
 * directory inside the workspace for every command an agent runs, so a broker started
 * by one of those — `bin/spawn.js` hosting the enzyme broker for a cell — read `tmpdir()`
 * and built its socket path under `<ws>/calls/<run>/<seq>/scratch/`. A workspace a few
 * directories deep then produced a path past the 108-byte `sun_path` limit and the bind
 * failed. Measured at 131 bytes: `AF_UNIX path too long`.
 */

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
