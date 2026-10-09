#!/usr/bin/env node
/**
 * Tags each plugin whose package.json version has no plugin-<name>-v<version> tag on origin, and
 * pushes those tags, which is what publishes them (.github/workflows/publish-plugin.yml). A
 * plugin is released by bumping its version and committing it; the others are left alone.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

const dirty = git('status', '--porcelain', '--', 'plugins')
if (dirty) {
  console.error(`tag-plugins: plugins/ has uncommitted changes — commit them first\n${dirty}`)
  process.exit(1)
}

const pushed = new Set(git('ls-remote', '--tags', 'origin', 'plugin-*').split('\n').filter(Boolean).map(line => line.split('refs/tags/')[1]))
const due = []
for (const name of readdirSync(join(ROOT, 'plugins')).sort()) {
  const file = join(ROOT, 'plugins', name, 'package.json')
  if (!existsSync(file)) continue
  const { version } = JSON.parse(readFileSync(file, 'utf8'))
  const tag = `plugin-${name}-v${version}`
  if (pushed.has(tag)) continue
  if (!git('tag', '--list', tag)) git('tag', tag)
  due.push(tag)
}

if (!due.length) {
  console.log('tag-plugins: every plugin version is on origin already')
  process.exit(0)
}
git('push', 'origin', ...due)
console.log(`tag-plugins: pushed ${due.join(', ')}`)
