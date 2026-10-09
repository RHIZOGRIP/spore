#!/usr/bin/env node
/**
 * The licenses of everything the published packages bring with them: every npm package a
 * workspace installs outside its devDependencies, and every crate in `Cargo.lock`. Lists each one
 * whose license is not permissive, or not stated, and exits 1 when there is any not reviewed in
 * `REVIEWED`, which says why each one there is acceptable.
 *
 *   node scripts/licenses.js
 */

import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PERMISSIVE = new Set([
  '0BSD', 'Apache-2.0', 'Apache-2.0 WITH LLVM-exception', 'BlueOak-1.0.0', 'BSD', 'BSD-2-Clause', 'BSD-3-Clause',
  'BSL-1.0', 'CC0-1.0', 'CDLA-Permissive-2.0', 'ISC', 'MIT', 'MIT-0', 'Python-2.0', 'Unicode-3.0', 'Unicode-DFS-2016',
  'Unlicense', 'X11', 'Zlib'
])

const REVIEWED = [
  [/^option-ext@/, 'MPL-2.0, per file: compiled unmodified into the native binaries through dirs, named in NOTICE with its source'],
  [/^@img\/sharp-libvips-/, 'LGPL-3.0: libvips, installed by npm for sharp in spore-plugin-images alone and loaded at run time, never part of a package spore publishes']
]

const LICENSE_NOT_IN_TARBALL = { 'buffers@0.1.1': 'MIT' }

const run = (command, args) => execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

/** `A OR B` is permissive when either is; `A AND B` when both are; `MIT/X11` is the old `OR`. */
function permissive (expression) {
  const alternatives = expression.replace(/[()]/g, '').split(/ OR |\//)
  return alternatives.some(alternative => alternative.split(' AND ').every(id => PERMISSIVE.has(id.trim())))
}

const licenseOf = (pkg) => typeof pkg.license === 'string'
  ? pkg.license
  : pkg.license?.type ?? (pkg.licenses ? [].concat(pkg.licenses).map(one => one.type ?? one).join(' OR ') : null)

function npmPackages () {
  let listed
  try {
    listed = run('npm', ['ls', '--workspaces', '--omit=dev', '--all', '--long', '--json'])
  } catch (err) {
    listed = err.stdout
  }
  const found = new Map()
  const walked = new Set()
  const walk = (deps) => {
    for (const [name, pkg] of Object.entries(deps ?? {})) {
      if (pkg.extraneous || !pkg.version) continue
      const key = `${name}@${pkg.version}`
      if (!found.get(key)) found.set(key, licenseOf(pkg) ?? LICENSE_NOT_IN_TARBALL[key] ?? null)
      if (pkg.dependencies && !walked.has(pkg)) {
        walked.add(pkg)
        walk(pkg.dependencies)
      }
    }
  }
  walk(JSON.parse(listed).dependencies)
  return found
}

function crates () {
  const { packages } = JSON.parse(run('cargo', ['metadata', '--format-version', '1', '--locked']))
  return new Map(packages.map(crate => [`${crate.name}@${crate.version}`, crate.license]))
}

let flagged = 0
for (const [ecosystem, found] of [['npm', npmPackages()], ['cargo', crates()]]) {
  const counts = {}
  const others = []
  const reviewed = []
  for (const [name, license] of found) {
    counts[license ?? 'none stated'] = (counts[license ?? 'none stated'] ?? 0) + 1
    if (license && permissive(license)) continue
    const why = REVIEWED.find(([pattern]) => pattern.test(name))?.[1]
    if (why) reviewed.push(`  ${name.padEnd(48)} ${license} — reviewed: ${why}`)
    else others.push(`  ${name.padEnd(48)} ${license ?? 'none stated'}`)
  }
  console.log(`${ecosystem}: ${found.size} — ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([license, n]) => `${n} ${license}`).join(', ')}`)
  for (const line of [...reviewed, ...others]) console.log(line)
  flagged += others.length
}
process.exit(flagged ? 1 : 0)
