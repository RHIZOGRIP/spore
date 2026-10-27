/**
 * The suite tests the native addon and binaries in `native/`, built from `rust/`. One older than
 * a Rust source tests the code before the change, so the run stops here and says to rebuild,
 * rather than failing further on with an assertion that blames the code.
 */

import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..')
const REPO = resolve(ROOT, '../..')
const BUILT = ['spore.node', 'spore-runner', 'spore-spawn'].map(name => join(ROOT, 'native', process.arch, name))

function sources (dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'target' ? [] : sources(path)
    return entry.name.endsWith('.rs') || entry.name === 'Cargo.toml' ? [path] : []
  })
}

const builtAt = Math.min(...BUILT.map(path => statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0))
const newer = [...sources(join(REPO, 'rust')), join(REPO, 'Cargo.toml'), join(REPO, 'Cargo.lock')]
  .filter(path => statSync(path).mtimeMs > builtAt)

if (newer.length) {
  throw new Error(builtAt === 0
    ? 'native/ is not built — npm run build:native'
    : `native/ is older than ${newer.length} Rust source(s), ${newer.slice(0, 3).map(path => path.slice(REPO.length + 1)).join(', ')}${newer.length > 3 ? ', …' : ''} — npm run build:native`)
}
