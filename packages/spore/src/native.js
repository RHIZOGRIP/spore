/**
 * The Rust side of the runtime, as one addon built from `rust/node`: the `.cmk` parser
 * (`rust/definition`) and the workspace rules (`rust/workspace`), each one implementation
 * shared with the Rust runner.
 */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This machine's binaries, the addon among them: the package carries one directory per architecture. */
export const NATIVE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'native', process.arch)

export const native = createRequire(import.meta.url)(join(NATIVE_DIR, 'spore.node'))
