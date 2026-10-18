import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SLOT_DIR } from '../core/admission.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Where a long-running service records the spore it started from. A running process keeps the
 * code it loaded, and an install replaces the files under it, with every file's time set to one
 * fixed date by npm — so the version it recorded is the only way to tell it is running older
 * code than is installed. A plugin's service records its own version and the spore's, since a
 * global install gives each plugin a copy of spore of its own, which moves while the plugin
 * does not.
 */
export const SERVICE_STATE_DIR = join(dirname(SLOT_DIR), 'services')

export const versionAt = (root) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

export function recordStarted (name, { dir = SERVICE_STATE_DIR, root = ROOT, pid = process.pid } = {}) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ version: versionAt(root), spore: versionAt(ROOT), pid }) + '\n')
}
