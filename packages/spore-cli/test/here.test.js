import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { CONFIG_FILE } from '@rhizogrip/spore'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { changesSince, gitStateText, pruneSnapshots, snapshot, sporeNameFor, undoTo, workTreeOf } from '../src/here.js'
import { here } from '../tui/here.js'

let repo, dir
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' })

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'spore-here-')))
  dir = join(repo, 'sub')
  mkdirSync(dir)
  git('init', '-q')
  git('config', 'user.email', 'test@localhost')
  git('config', 'user.name', 'test')
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  writeFileSync(join(repo, 'outside.txt'), 'kept\n')
  writeFileSync(join(repo, '.gitignore'), 'ignored.log\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
})

afterEach(() => rmSync(repo, { recursive: true, force: true }))

describe('the name of a directory\'s spore', () => {
  it('is readable, the same each time, and different for two directories of one name', () => {
    expect(sporeNameFor('/home/me/proj')).toMatch(/^proj-[0-9a-f]{6}$/)
    expect(sporeNameFor('/home/me/proj')).toBe(sporeNameFor('/home/me/proj'))
    expect(sporeNameFor('/a/src')).not.toBe(sporeNameFor('/b/src'))
    expect(sporeNameFor('/srv/.hidden dir')).toMatch(/^hidden-dir-[0-9a-f]{6}$/)
    expect(sporeNameFor('/')).toMatch(/^root-[0-9a-f]{6}$/)
  })
})

describe('git, as the undo', () => {
  it('knows the work tree, and says when there is none', () => {
    expect(workTreeOf(dir)).toBe(repo)
    expect(workTreeOf(tmpdir())).toBe(null)
    expect(gitStateText(dir)).toMatch(/^git: clean/)
    writeFileSync(join(dir, 'a.txt'), 'changed\n')
    expect(gitStateText(dir)).toMatch(/^git: 1 file changed/)
  })

  it('keeps the newest snapshots of a spore and drops the rest, leaving another spore\'s alone', () => {
    for (const session of ['20261001T090000Z', '20261002T090000Z', '20261003T090000Z']) snapshot(dir, { spore: 'sub-x', session })
    snapshot(dir, { spore: 'other-y', session: '20261001T090000Z' })

    expect(pruneSnapshots(dir, { spore: 'sub-x', keep: 2 })).toEqual(['refs/spore/sub-x/20261001T090000Z'])
    expect(git('for-each-ref', '--format=%(refname)', 'refs/spore/').trim().split('\n')).toEqual([
      'refs/spore/other-y/20261001T090000Z',
      'refs/spore/sub-x/20261002T090000Z',
      'refs/spore/sub-x/20261003T090000Z'
    ])
    expect(pruneSnapshots(dir, { spore: 'sub-x', keep: 2 })).toEqual([])
  })

  it('takes a snapshot that moves neither the work tree nor the index', () => {
    writeFileSync(join(dir, 'staged.txt'), 'staged\n')
    git('add', 'sub/staged.txt')
    writeFileSync(join(dir, 'a.txt'), 'dirty\n')
    const before = git('status', '--porcelain')

    const ref = snapshot(dir, { spore: 'sub-x', session: 's1' })

    expect(ref).toBe('refs/spore/sub-x/s1')
    expect(git('status', '--porcelain')).toBe(before)
    expect(git('show', `${ref}:sub/a.txt`)).toBe('dirty\n')
  })

  it('names what changed here since, untracked files included, and nothing outside', () => {
    const ref = snapshot(dir, { spore: 'sub-x', session: 's1' })
    writeFileSync(join(dir, 'a.txt'), 'changed\n')
    writeFileSync(join(dir, 'made.txt'), 'new\n')
    writeFileSync(join(dir, 'ignored.log'), 'noise\n')
    writeFileSync(join(repo, 'outside.txt'), 'changed outside\n')

    expect(changesSince(dir, ref)).toEqual([
      { status: 'M', path: 'sub/a.txt' },
      { status: 'A', path: 'sub/made.txt' }
    ])
  })

  it('puts the directory back: restores, brings back, removes — and leaves the ignored and the index alone', () => {
    writeFileSync(join(dir, 'staged.txt'), 'staged\n')
    git('add', 'sub/staged.txt')
    const ref = snapshot(dir, { spore: 'sub-x', session: 's1' })
    const index = git('diff', '--cached', '--name-only')
    writeFileSync(join(dir, 'a.txt'), 'changed\n')
    rmSync(join(dir, 'staged.txt'))
    writeFileSync(join(dir, 'made.txt'), 'new\n')
    writeFileSync(join(dir, 'ignored.log'), 'noise\n')

    undoTo(dir, ref)

    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('a\n')
    expect(readFileSync(join(dir, 'staged.txt'), 'utf8')).toBe('staged\n')
    expect(existsSync(join(dir, 'made.txt'))).toBe(false)
    expect(existsSync(join(dir, 'ignored.log'))).toBe(true)
    expect(git('diff', '--cached', '--name-only')).toBe(index)
    expect(changesSince(dir, ref)).toEqual([])
  })
})

describe('spore here, on a directory whose spore exists', () => {
  let home
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'spore-here-home-'))
    mkdirSync(dirname(CONFIG_FILE), { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify({ home }))
  })
  afterEach(() => {
    rmSync(CONFIG_FILE, { force: true })
    rmSync(home, { recursive: true, force: true })
  })

  it('refuses --sporangium and --model, which make a new one, and says what changes it', async () => {
    const name = sporeNameFor(dir)
    mkdirSync(join(home, name))
    writeFileSync(join(home, name, 'spore.cmk'), '---\nname: t\n---\n')
    for (const asked of [{ sporangium: 'reviewer' }, { model: 'm/b' }]) {
      await expect(here({ dir, ...asked })).rejects.toMatchObject({ type: 'DEFINE_FILLS_ONLY_NEW', detail: expect.stringContaining(`spore edit ${name} changes it`) })
    }
  })
})
