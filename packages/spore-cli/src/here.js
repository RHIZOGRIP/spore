/**
 * `spore here`: the spore a directory is worked in by, and git as its undo. A session's start is
 * a commit of the directory as it stands — tracked and untracked files, `.gitignore` respected —
 * written through an index of its own, so neither the work tree nor the user's index moves.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'

const IDENTITY = { GIT_AUTHOR_NAME: 'spore', GIT_AUTHOR_EMAIL: 'spore@localhost', GIT_COMMITTER_NAME: 'spore', GIT_COMMITTER_EMAIL: 'spore@localhost' }

export function sporeNameFor (dir) {
  const readable = basename(dir).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 48) || 'root'
  return `${readable}-${createHash('sha256').update(dir).digest('hex').slice(0, 6)}`
}

const git = (cwd, args, env = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()

export function workTreeOf (dir) {
  try {
    return git(dir, ['rev-parse', '--show-toplevel'])
  } catch (err) {
    if (/not a git repository/.test(err.stderr ?? '')) return null
    throw err
  }
}

export function gitStateText (dir) {
  const top = workTreeOf(dir)
  if (!top) return 'not a git repository — nothing can be undone'
  const changed = git(dir, ['status', '--porcelain', '--', '.']).split('\n').filter(Boolean).length
  return changed ? `git: ${changed} file${changed > 1 ? 's' : ''} changed, a snapshot is taken each session` : 'git: clean, a snapshot is taken each session'
}

const withIndex = (fn) => {
  const scratch = mkdtempSync(join(tmpdir(), 'spore-here-'))
  try {
    return fn({ GIT_INDEX_FILE: join(scratch, 'index') })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export function treeOf (dir) {
  const top = workTreeOf(dir)
  const scope = relative(top, dir) || '.'
  return withIndex(index => {
    git(top, ['add', '-A', '--', scope], index)
    return git(top, ['write-tree'], index)
  })
}

/** A commit of `dir` as it stands, kept under `refs/spore/<spore>/<session>`; its ref. */
export function snapshot (dir, { spore, session }) {
  const top = workTreeOf(dir)
  const commit = git(top, ['commit-tree', treeOf(dir), '-m', `spore ${spore}: session ${session}`], IDENTITY)
  const ref = `refs/spore/${spore}/${session}`
  git(top, ['update-ref', ref, commit])
  return ref
}

const KEPT = 3

/**
 * Drops all but the newest `KEPT` of `spore`'s session snapshots, so what an old one holds — an
 * untracked file since deleted — leaves `.git` with it; the refs dropped, oldest first. A session
 * reads only its own; more than one is kept for another session of the spore still open. Session
 * names are UTC times, so their order is their names'.
 */
export function pruneSnapshots (dir, { spore }) {
  const top = workTreeOf(dir)
  const refs = git(top, ['for-each-ref', '--sort=refname', '--format=%(refname)', `refs/spore/${spore}/`]).split('\n').filter(Boolean)
  const dropped = refs.slice(0, Math.max(0, refs.length - KEPT))
  for (const ref of dropped) git(top, ['update-ref', '-d', ref])
  return dropped
}

/** What changed in `dir` since `ref`: `{ status, path }`, A added, M modified, D deleted. */
export function changesSince (dir, ref) {
  const top = workTreeOf(dir)
  const out = git(top, ['diff', '--no-renames', '--name-status', `${ref}^{tree}`, treeOf(dir)])
  return out.split('\n').filter(Boolean).map(line => {
    const [status, path] = line.split('\t')
    return { status, path }
  })
}

export function diffArgs (dir, ref) {
  return { cwd: workTreeOf(dir), args: ['diff', `${ref}^{tree}`, treeOf(dir)] }
}

/** Puts `dir` back as it was at `ref`: what changed or went is restored, what was made is removed. */
export function undoTo (dir, ref) {
  const top = workTreeOf(dir)
  const changes = changesSince(dir, ref)
  const restore = changes.filter(c => c.status !== 'A').map(c => c.path)
  if (restore.length) {
    withIndex(index => {
      git(top, ['read-tree', `${ref}^{tree}`], index)
      execFileSync('git', ['checkout-index', '-f', '--stdin'], { cwd: top, input: restore.join('\n') + '\n', env: { ...process.env, ...index }, stdio: ['pipe', 'pipe', 'pipe'] })
    })
  }
  for (const { path } of changes.filter(c => c.status === 'A')) unlinkSync(join(top, path))
  return changes
}
