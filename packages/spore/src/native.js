/**
 * The Rust side of the runtime, as one addon built from `rust/node`: the `.cmk` parser
 * (`rust/definition`) and the workspace rules (`rust/workspace`), each one implementation
 * shared with the Rust runner.
 */

import { createRequire } from 'node:module'

export const native = createRequire(import.meta.url)('../native/spore.node')
