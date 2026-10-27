/**
 * What this machine is, as far as spore's confinement cares: what runs it, its kernel and the
 * security modules in front of it, and where it runs. Read, never changed, and naming no path,
 * user or host.
 */

import { existsSync, readFileSync } from 'node:fs'
import { release } from 'node:os'
import { createRequire } from 'node:module'

import { containCheck } from '../core/command.js'
import { nodeSqliteVersion } from '../core/sqlite.js'
import { landlockAbi } from '../isolation/sandbox.js'

const RESTRICTS_USERNS = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'

const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '')

/** Whether AppArmor restricts unprivileged user namespaces, as Ubuntu does from 23.10; null where this kernel has no such switch. */
export function appArmorRestricts () {
  const restricts = read(RESTRICTS_USERNS).trim()
  return restricts === '' ? null : restricts === '1'
}

function system () {
  const fields = Object.fromEntries(read('/etc/os-release').split('\n').map(line => /^([A-Z_]+)="?(.*?)"?$/.exec(line)).filter(Boolean).map(([, key, value]) => [key, value]))
  return fields.PRETTY_NAME ?? ([fields.ID, fields.VERSION_ID].filter(Boolean).join(' ') || 'unknown')
}

function runsIn () {
  if (process.env.KUBERNETES_SERVICE_HOST) return 'a Kubernetes pod'
  if (existsSync('/run/.containerenv')) return 'a Podman container'
  if (existsSync('/.dockerenv')) return 'a Docker container'
  if (/microsoft/i.test(read('/proc/version'))) return 'WSL'
  if (/^flags\s*:.*\bhypervisor\b/m.test(read('/proc/cpuinfo'))) return 'a virtual machine'
  return 'no container or virtual machine it could tell'
}

/**
 * `{ spore, node, sqlite, arch, system, kernel, landlock, appArmor, contain, runsIn }`: `landlock`
 * the ABI or -errno, `appArmor` whether it restricts unprivileged user namespaces — null where
 * the kernel has no such switch — and `contain` as `confine --contain-check` answers.
 */
export function describeHost () {
  const restricts = appArmorRestricts()
  return {
    spore: createRequire(import.meta.url)('../../package.json').version,
    node: process.version,
    sqlite: nodeSqliteVersion(),
    arch: process.arch,
    system: system(),
    kernel: release(),
    landlock: landlockAbi(),
    appArmor: restricts === null ? null : restricts ? 'restricts user namespaces' : 'allows user namespaces',
    contain: containCheck(),
    runsIn: runsIn()
  }
}
