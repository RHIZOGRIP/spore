/**
 * Landlock sandbox — confines the process to the workspace: all of it readable, one
 * directory beneath it writable. Kernel-enforced, irreversible, inherited by child processes.
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdirSync, realpathSync } from 'node:fs'
import { silent } from '../observability/logger.js'
import { safePath } from './safe-path.js'
import { native as rules } from '../native.js'
import { SporeError } from '../observability/errors.js'

const require = createRequire(import.meta.url)
const native = require('../../build/Release/sandbox.node')

const __dirname = dirname(fileURLToPath(import.meta.url))
const sporeRoot = resolve(__dirname, '..', '..')
const nodeBin = dirname(realpathSync(process.execPath))

/** Where hoisted dependencies live when spore is installed inside another package. */
export function getNodeModulesRoot () {
  return rules.nodeModulesRoot(sporeRoot)
}

/**
 * What a confined agent may read: the system, the runtime's own programs, binaries and
 * sporangia, and its dependencies — never the checkout. `rust/workspace`'s list, shared with
 * the Rust cell supervisor, and the directory of the node running spore, which a version
 * manager or a CI image puts outside the system's.
 */
export function systemReadPaths () {
  return [...rules.systemReadPaths(sporeRoot), nodeBin]
}

/**
 * Every path the sandbox hands out, read or write. A workspace inside one of
 * these cannot isolate a child confined beneath it: the surroundings stay
 * reachable through the grant rather than through the workspace. `extra` is what a
 * definition declared it may read, which is a grant like any other.
 */
export function grantedPathContaining (target, extra = []) {
  const answer = JSON.parse(rules.grantedPathContaining(sporeRoot, target, extra))
  if (answer.error) throw Object.assign(new Error(`${answer.error.message}, realpath '${target}'`), { code: answer.error.code, path: target })
  return answer.granted
}

/**
 * Why a spore at `ws` may not write `writes` (`[[name, path], …]`), or null when it may — the
 * runner's own check at turn start, for a caller refusing before it makes anything.
 */
export function writesRefusal (ws, writes, reads = []) {
  return rules.writesRefusal(sporeRoot, ws, writes, reads)
}

/** The Landlock ABI version this kernel offers, or -errno when it offers none. */
export function landlockAbi () {
  return native.abi()
}

/**
 * Apply landlock sandbox. Call once at startup, before any LLM interaction.
 *
 * @param {string} workspace — workspace path
 * @param {object} opts
 * @param {string} opts.writeDir — path relative to `workspace` that becomes the only
 *   writable location; `workspace` itself is read-only.
 * @param {string[]} [opts.extraWritePaths] — additional paths the child needs to write
 *   outside its workspace.
 * @param {string[]} [opts.extraReadPaths] — corpora the definition declared it may read.
 * @param {object} [opts.logger]
 * @returns {number} landlock ABI version
 */
export function sandbox (workspace, { writeDir, extraWritePaths = [], extraReadPaths = [], logger = silent }) {
  if (!writeDir) throw new Error('sandbox() needs a writeDir: the workspace itself is never writable')
  const readPaths = [...systemReadPaths(), ...extraReadPaths.filter(Boolean)]
  const writePaths = ['/dev/null', ...extraWritePaths.filter(Boolean)]

  // Landlock adds up the rights of every rule along a path, so `workspace` as a read path
  // and `writeDir` as a write path yield exactly: read all of workspace, write only beneath
  // writeDir. A write right on any parent would hand over everything under it. A caller that
  // delegates this way keeps its own ruleset — restrict_self binds the calling process only.
  // Either this process comes back confined or it does not come back: preparing the
  // write root and installing the ruleset are the same commitment, and a caller that
  // asked for confinement must not carry on without it.
  try {
    const fullWriteDir = safePath(workspace, writeDir)
    mkdirSync(fullWriteDir, { recursive: true })
    const abi = native.sandbox({ readPaths: [...readPaths, workspace], writePaths: [fullWriteDir, ...writePaths] })
    logger.info({ abi, workspace, writeDir: fullWriteDir }, '[sandbox] landlock — confined')
    return abi
  } catch (err) {
    throw unconfined(err, workspace)
  }
}

/**
 * Confinement that was asked for and did not happen is a stop, not a warning.
 * Returning a code the caller ignored meant a host without Landlock — an old
 * kernel, a blocked syscall, a rule that would not install — ran `wsexec`
 * unrestricted while everything above still believed it was sandboxed. Running
 * without it is a decision someone makes in the definition, `unconfined: true`, not
 * one a failure makes for them.
 */
function unconfined (err, workspace) {
  return new SporeError('sandbox failed', {
    type: 'SANDBOX_FAILED',
    detail: `Landlock could not confine this process (${err.message}). A spore runs its turns without confinement only when its spore.cmk says unconfined: true.`,
    context: { workspace },
    cause: err
  })
}
