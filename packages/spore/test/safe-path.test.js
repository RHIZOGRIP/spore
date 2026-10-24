import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { safePath, hasDotSegment } from '../src/isolation/safe-path.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.safepath-workspace')

describe('safePath', () => {
  beforeAll(() => {
    mkdirSync(resolve(WS, 'sub/dir'), { recursive: true })
    writeFileSync(resolve(WS, 'file.txt'), 'hello')
    writeFileSync(resolve(WS, 'sub/nested.txt'), 'nested')
    // Symlink pointing outside workspace
    try { symlinkSync('/etc/hostname', resolve(WS, 'escape-link')) } catch {}
    // Symlink pointing inside workspace
    try { symlinkSync(resolve(WS, 'file.txt'), resolve(WS, 'safe-link')) } catch {}
  })

  afterAll(() => {
    rmSync(WS, { recursive: true, force: true })
  })

  it('resolves simple relative paths', () => {
    const p = safePath(WS, 'file.txt')
    expect(p).toBe(resolve(WS, 'file.txt'))
  })

  it('resolves nested paths', () => {
    const p = safePath(WS, 'sub/nested.txt')
    expect(p).toBe(resolve(WS, 'sub/nested.txt'))
  })

  it('allows new files in existing directories', () => {
    const p = safePath(WS, 'sub/new-file.txt')
    expect(p).toBe(resolve(WS, 'sub/new-file.txt'))
  })

  it('rejects ../ traversal', () => {
    expect(() => safePath(WS, '../../../etc/passwd')).toThrow(expect.objectContaining({ type: 'PATH_ESCAPE' }))
  })

  it('rejects absolute paths', () => {
    expect(() => safePath(WS, '/etc/passwd')).toThrow(expect.objectContaining({ type: 'PATH_ABSOLUTE' }))
  })

  it('rejects null bytes', () => {
    expect(() => safePath(WS, 'file\0.txt')).toThrow(expect.objectContaining({ type: 'PATH_NULL_BYTE' }))
  })

  it('rejects symlinks pointing outside workspace', () => {
    expect(() => safePath(WS, 'escape-link')).toThrow(expect.objectContaining({ type: 'PATH_ESCAPE' }))
  })

  // Only the immediate parent used to be canonicalised, so one missing segment was
  // caught and two were not: nothing along the path got resolved and the link out
  // of the workspace went unnoticed.
  it('rejects a symlinked directory however many segments are still missing', () => {
    const outside = resolve(WS, '..', 'safe-path-outside')
    mkdirSync(outside, { recursive: true })
    try { symlinkSync(outside, resolve(WS, 'out-link')) } catch {}
    try {
      expect(() => safePath(WS, 'out-link/file.txt')).toThrow(/escapes workspace/)
      expect(() => safePath(WS, 'out-link/new-dir/file.txt')).toThrow(/escapes workspace/)
      expect(() => safePath(WS, 'out-link/a/b/c/file.txt')).toThrow(/escapes workspace/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  // `existsSync` follows the link it is asked about, so a dangling one read as a
  // plain missing filename — and the write then followed it out of the workspace.
  it('rejects a dangling symlink pointing outside, and keeps one pointing in', () => {
    const outside = resolve(WS, '..', 'safe-path-dangling')
    try { symlinkSync(resolve(outside, 'absent.txt'), resolve(WS, 'out-dangling')) } catch {}
    try { symlinkSync(resolve(WS, 'not-yet.txt'), resolve(WS, 'in-dangling')) } catch {}

    expect(() => safePath(WS, 'out-dangling')).toThrow(/escapes workspace/)
    // A link to a file that does not exist yet is legitimate and still resolves.
    expect(safePath(WS, 'in-dangling')).toBe(resolve(WS, 'not-yet.txt'))
  })

  it('still allows a new path several directories deep inside the workspace', () => {
    expect(safePath(WS, 'a/b/c/new.txt')).toBe(resolve(WS, 'a/b/c/new.txt'))
  })

  it('allows symlinks pointing inside workspace', () => {
    const p = safePath(WS, 'safe-link')
    expect(p).toBe(resolve(WS, 'file.txt')) // resolves to real path
  })

  it('rejects empty paths', () => {
    expect(() => safePath(WS, '')).toThrow(expect.objectContaining({ type: 'PATH_EMPTY' }))
  })

  it('handles new files in new subdirectories', () => {
    // Parent doesn't exist, but path is within workspace
    const p = safePath(WS, 'new-dir/new-file.txt')
    expect(p).toBe(resolve(WS, 'new-dir/new-file.txt'))
  })
})

describe('hasDotSegment', () => {
  it('detects dotfiles', () => {
    expect(hasDotSegment('.hidden')).toBe(true)
    expect(hasDotSegment('dir/.hidden')).toBe(true)
    expect(hasDotSegment('.git/config')).toBe(true)
  })

  it('allows normal paths', () => {
    expect(hasDotSegment('file.txt')).toBe(false)
    expect(hasDotSegment('dir/file.txt')).toBe(false)
    expect(hasDotSegment('src/index.js')).toBe(false)
  })

  // A workspace may itself sit under a dot-prefixed dir; absolute paths
  // inside it must NOT trigger the dotdir guard on the workspace's own
  // prefix.
  it('treats absolute paths inside the workspace as relative-to-workspace', () => {
    const ws = '/tmp/session/.local/ws'
    expect(hasDotSegment(`${ws}/file.txt`, ws)).toBe(false)
    expect(hasDotSegment(`${ws}/sub/file.txt`, ws)).toBe(false)
  })

  it('still blocks dotdir traversal inside the workspace', () => {
    const ws = '/tmp/session/.local/ws'
    expect(hasDotSegment(`${ws}/.git/config`, ws)).toBe(true)
    expect(hasDotSegment(`${ws}/sub/.env`, ws)).toBe(true)
  })

  it('absolute paths outside the workspace are checked unchanged', () => {
    const ws = '/tmp/session/.local/ws'
    expect(hasDotSegment('/etc/.shadow', ws)).toBe(true)
  })

  it('relative paths are unaffected by the workspace arg', () => {
    expect(hasDotSegment('.git/config', '/tmp/session')).toBe(true)
    expect(hasDotSegment('file.txt', '/tmp/session')).toBe(false)
  })
})
