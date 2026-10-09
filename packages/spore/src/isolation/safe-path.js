/**
 * Canonical path containment — prevents symlink/traversal escapes. The rule is
 * `rust/workspace`'s `safe_path`, shared with the Rust cell supervisor.
 */

import { resolve, relative, isAbsolute } from 'node:path'
import { native } from '../native.js'
import { SporeError } from '../observability/errors.js'

/**
 * Validate and resolve a path within a workspace.
 * Throws if the resolved canonical path escapes the workspace.
 *
 * @param {string} workspace — canonical workspace root
 * @param {string} userPath — relative path from user/LLM
 * @returns {string} canonical absolute path guaranteed within workspace
 */
export function safePath (workspace, userPath, { reads = [] } = {}) {
  const answer = JSON.parse(native.safePath(workspace, userPath ?? '', reads))
  if (answer.error) {
    throw new SporeError(answer.error.message, {
      type: answer.error.type,
      detail: answer.error.detail,
      context: { userPath, workspace }
    })
  }
  return answer.path
}

/**
 * Resolve a read-only mount — maps a virtual prefix to an external directory.
 *
 * Used by read_file / list_files to serve shared content (e.g. product docs)
 * without modifying safePath or adding symlinks. Write tools never call this.
 *
 * @param {string} userPath — relative path from user/LLM (e.g. 'docs/faq.md')
 * @param {Object<string, string>} mounts — prefix → absolute target (e.g. { docs: '/shared/docs' })
 * @returns {string|null} absolute path within mount target, or null if no match / escape
 */
export function resolveReadMount (userPath, mounts) {
  if (!userPath || !mounts) return null
  if (userPath.includes('\0')) return null
  for (const [prefix, target] of Object.entries(mounts)) {
    if (userPath === prefix || userPath.startsWith(prefix + '/')) {
      const rest = userPath.slice(prefix.length).replace(/^\//, '')
      const resolved = rest ? resolve(target, rest) : target
      const rel = relative(target, resolved)
      if (rel.startsWith('..') || isAbsolute(rel)) return null
      return resolved
    }
  }
  return null
}

/**
 * Check if a path traverses through a dotfile/dotdir segment.
 *
 * Guards against the LLM reaching `.git`, `.env`, `.ssh`, etc. inside
 * its workspace. The workspace itself may legitimately sit under a
 * dot-prefixed dir (`~/.local/share/agent/ws`); when `workspace` is
 * given and `p` is an absolute path inside it, segments are evaluated
 * AFTER the workspace boundary so its own dot-prefix does not
 * false-trigger. Without `workspace`, the whole path is checked.
 */
export function hasDotSegment (p, workspace) {
  let toCheck = p
  if (workspace && isAbsolute(p)) {
    const wsAbs = resolve(workspace)
    if (p === wsAbs || p.startsWith(wsAbs + '/')) {
      toCheck = p.slice(wsAbs.length).replace(/^\/+/, '')
    }
  }
  return toCheck.split('/').some(s => s.startsWith('.'))
}
