#!/usr/bin/env node
/**
 * Carries the root `package.json`'s version into each published package under `packages/` and
 * their entries in `package-lock.json`, and into the Rust workspace: `[workspace.package]` in
 * `Cargo.toml`, which every crate inherits, and those crates' entries in `Cargo.lock` — so the
 * release commit leaves nothing for the next install or build to rewrite. release-it's
 * `after:bump` hook.
 *
 *   node scripts/sync-version.js           the version package.json holds
 *   node scripts/sync-version.js 3.1.0     a given one
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CRATES = ['spore-definition', 'spore-workspace', 'spore-node', 'spore-runner']
const PACKAGES = ['spore', 'spore-cli']

const version = process.argv[2] ?? JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`sync-version: "${version}" is not a version`)
  process.exit(1)
}

const rewrite = (file, pattern, what) => {
  const path = resolve(ROOT, file)
  const source = readFileSync(path, 'utf8')
  if (!pattern.test(source)) {
    console.error(`sync-version: no ${what} in ${file}`)
    process.exit(1)
  }
  writeFileSync(path, source.replace(pattern, `$1"${version}"`))
}

rewrite('Cargo.toml', /(\[workspace\.package\][^[]*?\nversion\s*=\s*)"[^"]+"/, '[workspace.package] version')
for (const crate of CRATES) {
  rewrite('Cargo.lock', new RegExp(`(\\nname = "${crate}"\\nversion = )"[^"]+"`), `${crate} entry`)
}
for (const pkg of PACKAGES) {
  rewrite(`packages/${pkg}/package.json`, /(\n {2}"version": )"[^"]+"/, 'version')
}
rewrite('packages/spore-cli/package.json', /(\n {4}"@rhizogrip\/spore": )"[^"]+"/, 'dependency on @rhizogrip/spore')
for (const pkg of PACKAGES) {
  rewrite('package-lock.json', new RegExp(`(\\n {4}"packages/${pkg}": \\{\\n {6}"name": "@rhizogrip/${pkg}",\\n {6}"version": )"[^"]+"`), `packages/${pkg} entry`)
}
rewrite('package-lock.json', /(\n {4}"packages\/spore-cli": \{[^}]*?\n {8}"@rhizogrip\/spore": )"[^"]+"/, 'packages/spore-cli entry\'s dependency on @rhizogrip/spore')
console.log(`sync-version: Cargo.toml, Cargo.lock, package-lock.json and packages/{${PACKAGES.join(',')}} at ${version}`)
