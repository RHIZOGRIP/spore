import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { follow, tailFrom } from '../src/library/follow.js'
import { ERR_FILE, OUT_FILE } from '../src/core/spore-dir.js'

let ws

beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'spore-follow-')) })
afterEach(() => rmSync(ws, { recursive: true, force: true }))

const sink = () => {
  const writes = []
  return { writes, write: (text) => { writes.push(text); return true } }
}

const readAt = (path, at) => readFileSync(path).subarray(at).toString('utf8')

describe('the lines attach starts with', () => {
  it('are the last ones, counted in bytes rather than characters', () => {
    const path = join(ws, OUT_FILE)
    writeFileSync(path, 'a😀b\nç😀\nz😀\n')
    expect(readAt(path, tailFrom(path, 2))).toBe('ç😀\nz😀\n')
  })

  it('never start inside a character when the window holds fewer lines', () => {
    const path = join(ws, OUT_FILE)
    writeFileSync(path, '😀'.repeat(20_000) + 'y')
    const shown = readAt(path, tailFrom(path, 3))
    expect(shown).not.toContain('�')
    expect(shown.endsWith('😀y')).toBe(true)
  })
})

describe('following a stream', () => {
  it('keeps a character whole when it arrives in two reads', async () => {
    const out = sink()
    const bytes = Buffer.from('before 😀 after\n')
    const cut = bytes.indexOf(Buffer.from('😀')) + 2
    writeFileSync(join(ws, OUT_FILE), '')
    writeFileSync(join(ws, ERR_FILE), '')
    setTimeout(() => appendFileSync(join(ws, OUT_FILE), bytes.subarray(0, cut)), 60)
    setTimeout(() => appendFileSync(join(ws, OUT_FILE), bytes.subarray(cut)), 160)

    await follow(ws, { out, err: sink(), tick: 20, grace: 300 })
    expect(out.writes.length).toBeGreaterThan(1)
    expect(out.writes.join('')).toBe('before 😀 after\n')
  })
})
