import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { headAndTail } from '../src/core/preview.js'
import { INLINE_MESSAGE_BYTES, appendInbox, readInbox, readInboxFrom, saidOf } from '../src/core/spore-dir.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.inbox-files-workspace')

const long = (n = INLINE_MESSAGE_BYTES + 1000) => 'x'.repeat(n)
const only = (ws) => readInbox(ws).at(-1)

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
})

afterEach(() => {
  rmSync(WS, { recursive: true, force: true })
})

describe('a message short enough to carry', () => {
  it('stays in the entry, as it always has', () => {
    appendInbox(WS, 'hello')
    expect(only(WS).text).toBe('hello')
    expect(only(WS).bodyPath).toBeNull()
    expect(existsSync(resolve(WS, 'inbox.d'))).toBe(false)
  })
})

describe('a message too long to carry', () => {
  it('goes to a file, and the entry points at it', () => {
    appendInbox(WS, long())
    const { bodyPath, bodyBytes, text } = only(WS)
    expect(text).toBeNull()
    expect(bodyBytes).toBe(INLINE_MESSAGE_BYTES + 1000)
    expect(readFileSync(resolve(WS, bodyPath), 'utf8')).toBe(long())
  })

  it('carries both ends, because the ask sits at one of them', () => {
    const log = Array.from({ length: 800 }, (_, i) => `line ${i} of log`).join('\n') + '\nwhy does this fail?'
    appendInbox(WS, log)
    const entry = only(WS)
    expect(entry.bodyHead).toContain('line 0 of log')
    expect(entry.bodyTail).toContain('why does this fail?')
    expect(saidOf(entry)).toContain(`${log.length - entry.bodyHead.length - entry.bodyTail.length} bytes of it are not below`)
  })

  it('is read as a pointer plus both ends, never as a silent truncation', () => {
    appendInbox(WS, 'INSTRUCTION AT THE TOP\n' + long())
    const said = readInboxFrom(WS).messages[0]
    expect(said).toContain('inbox.d/')
    expect(said).toContain('INSTRUCTION AT THE TOP')
    expect(said).toMatch(/bytes of it are not below/)
  })
})

describe('a file sent with a message', () => {
  const pdf = { name: 'report.pdf', mime: 'application/pdf', data: Buffer.from('%PDF-1.4') }

  it('lands beside the message and is named in the entry', () => {
    appendInbox(WS, 'have a look', { attach: [pdf] })
    const entry = only(WS)
    expect(entry.text).toBe('have a look')
    expect(entry.files).toHaveLength(1)
    expect(entry.files[0]).toMatchObject({ name: 'report.pdf', mime: 'application/pdf', bytes: 8 })
    expect(readFileSync(resolve(WS, entry.files[0].path), 'utf8')).toBe('%PDF-1.4')
  })

  it('reaches the turn as its path, with the message', () => {
    appendInbox(WS, 'have a look', { attach: [pdf] })
    const said = readInboxFrom(WS).messages[0]
    expect(said).toContain('have a look')
    expect(said).toContain('Sent with this message')
    expect(said).toContain('report.pdf')
  })

  // The name comes from outside and picks the file it lands on.
  it('cannot name a path out of the directory it lands in', () => {
    appendInbox(WS, 'note', { attach: [{ name: '../../etc/passwd', data: Buffer.from('x') }] })
    const { files } = only(WS)
    expect(files[0].path).not.toContain('..')
    expect(resolve(WS, files[0].path).startsWith(resolve(WS, 'inbox.d'))).toBe(true)
    expect(basename(files[0].path)).toBe('passwd')
    expect(files[0].name).toBe('../../etc/passwd')
  })

  it('carries a body and files together when both are big enough to need it', () => {
    appendInbox(WS, long(), { attach: [pdf] })
    const entry = only(WS)
    expect(entry.bodyPath).toBeTruthy()
    expect(entry.files).toHaveLength(1)
    expect(dirname(entry.bodyPath)).toBe(dirname(entry.files[0].path))
  })
})

describe('two callers at once', () => {
  it('never land on the same directory', () => {
    for (let i = 0; i < 12; i++) appendInbox(WS, long())
    const dirs = new Set(readInbox(WS).map(e => dirname(e.bodyPath)))
    expect(dirs.size).toBe(12)
  })
})

describe('both ends of something long', () => {
  it('returns the whole thing when it is short enough for both ends to cover it', () => {
    expect(headAndTail('brief', { each: 100 })).toEqual({ head: 'brief', tail: '', elided: 0 })
  })

  it('cuts on a line boundary when one is near, so no line comes back in halves', () => {
    const lines = ('word word word word\n').repeat(200)
    const { head, tail } = headAndTail(lines, { each: 100 })
    expect(lines.startsWith(head + '\n')).toBe(true)
    expect(lines.endsWith('\n' + tail) || lines.endsWith(tail)).toBe(true)
  })

  it('cuts hard when the text has no lines to cut on', () => {
    expect(headAndTail('y'.repeat(5000), { each: 100 }).head.length).toBe(100)
  })

  it('accounts for every byte exactly once, in the unit the file is measured in', () => {
    const text = 'héllo ' + 'ü'.repeat(3000)
    const { head, tail, elided } = headAndTail(text, { each: 200 })
    expect(Buffer.byteLength(head) + Buffer.byteLength(tail) + elided).toBe(Buffer.byteLength(text))
  })
})

describe('what an entry says it is', () => {
  it('is empty for nothing, so an entry that says nothing cannot become a turn', () => {
    expect(saidOf(null)).toBe('')
    expect(saidOf({ at: 'now', text: null, bodyPath: null, files: null, schedule: null, due: null })).toBe('')
  })
})
