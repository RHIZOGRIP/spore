#!/usr/bin/env node
/**
 * Puts what the build made — cargo's addon and binaries, node-gyp's sandbox addon and confine —
 * in native/<arch>/, each through a temporary name so a spore running meanwhile never loads half
 * a file.
 */

import { copyFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CARGO = resolve(ROOT, '../../target/release')
const GYP = resolve(ROOT, 'build/Release')
const BUILT = [
  [CARGO, 'libspore_node.so', 'spore.node'],
  [CARGO, 'spore-runner'],
  [CARGO, 'spore-spawn'],
  [GYP, 'sandbox.node'],
  [GYP, 'confine']
]

const dir = join(ROOT, 'native', process.arch)
mkdirSync(dir, { recursive: true })
for (const [from, name, as = name] of BUILT) {
  const to = join(dir, as)
  copyFileSync(join(from, name), `${to}.new`)
  renameSync(`${to}.new`, to)
}
