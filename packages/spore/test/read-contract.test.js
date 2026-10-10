import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeTools } from '../src/tools/make-tools.js'
import { createCallTrail, readCall } from '../src/core/call-record.js'
import { hostState } from '../src/core/spore-dir.js'
import { shownToModel } from './fixtures/as-shown.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.read-contract-workspace')
const BUDGET = 500

let read

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
  read = shownToModel(makeTools(WS, BUDGET, createCallTrail(WS, { runId: 'test', state: hostState(WS) })).fns).read
})

afterEach(() => {
  rmSync(WS, { recursive: true, force: true })
})

describe('read as the contract exception', () => {
  it('returns content directly, with the facts around it', async () => {
    writeFileSync(resolve(WS, 'a.txt'), 'one\ntwo\nthree\n')
    const meta = JSON.parse(await read({ path: 'a.txt' }))
    expect(meta.content).toBe('one\ntwo\nthree\n')
    expect(meta.tool).toBe('read')
    expect(meta.lines).toBe(3)
    expect(meta.bytes).toBe(14)
    expect(meta.encoding).toBe('utf-8')
    const trail = readCall(WS, 'test', meta.call)
    expect(trail.hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('slices by line with offset and length', async () => {
    writeFileSync(resolve(WS, 'a.txt'), 'l1\nl2\nl3\nl4\nl5\n')
    const meta = JSON.parse(await read({ path: 'a.txt', offset: 2, length: 2 }))
    expect(meta.content).toBe('l2\nl3\n')
    expect(meta.lines).toBe(2)
    expect(meta.eof).toBe(false)
  })

  it('reads a final line with no trailing newline', async () => {
    writeFileSync(resolve(WS, 'a.txt'), 'x\nlast')
    const meta = JSON.parse(await read({ path: 'a.txt' }))
    expect(meta.content).toBe('x\nlast')
    expect(meta.lines).toBe(2)
    expect(meta.eof).toBe(true)
  })

  it('refuses an over-budget whole file instead of truncating', async () => {
    writeFileSync(resolve(WS, 'big.txt'), 'y'.repeat(BUDGET + 1))
    const result = await read({ path: 'big.txt' })
    expect(result).toMatch(/over the 500 byte read budget/)
    expect(result).toMatch(/offset and length/)
  })

  it('refuses an over-budget slice instead of truncating', async () => {
    writeFileSync(resolve(WS, 'big.txt'), ('z'.repeat(100) + '\n').repeat(20))
    const result = await read({ path: 'big.txt', offset: 1, length: 20 })
    expect(result).toMatch(/exceed the 500 byte read budget/)
  })

  it('transcodes a non-UTF-8 source', async () => {
    writeFileSync(resolve(WS, 'l1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
    const failed = await read({ path: 'l1.txt' })
    expect(failed).toMatch(/does not decode as utf-8/)
    const meta = JSON.parse(await read({ path: 'l1.txt', encoding: 'latin1' }))
    expect(meta.content).toBe('café\n')
    expect(meta.encoding).toBe('latin1')
  })

  it('slices by byte with unit bytes, 0-based', async () => {
    writeFileSync(resolve(WS, 'a.txt'), 'abcdefghij')
    const meta = JSON.parse(await read({ path: 'a.txt', unit: 'bytes', offset: 2, length: 3 }))
    expect(meta.content).toBe('cde')
    expect(meta.unit).toBe('bytes')
    expect(meta.bytesRead).toBe(3)
    expect(meta.eof).toBe(false)
  })

  it('reports eof when a byte range reaches the end', async () => {
    writeFileSync(resolve(WS, 'a.txt'), 'abcdefghij')
    const meta = JSON.parse(await read({ path: 'a.txt', unit: 'bytes', offset: 7 }))
    expect(meta.content).toBe('hij')
    expect(meta.eof).toBe(true)
  })

  it('refuses an over-budget byte range', async () => {
    writeFileSync(resolve(WS, 'big.txt'), 'y'.repeat(BUDGET + 100))
    const result = await read({ path: 'big.txt', unit: 'bytes', length: BUDGET + 1 })
    expect(result).toMatch(/over the 500 byte read budget/)
  })

  it('names the split-character case when a byte range cuts one', async () => {
    writeFileSync(resolve(WS, 'u.txt'), 'café')
    const result = await read({ path: 'u.txt', unit: 'bytes', offset: 0, length: 4 })
    expect(result).toMatch(/may split a multi-byte character/)
  })

  it('rejects an unknown unit', async () => {
    writeFileSync(resolve(WS, 'a.txt'), 'x\n')
    expect(await read({ path: 'a.txt', unit: 'words' })).toMatch(/unit must be lines or bytes/)
  })

  it('takes an empty unit or encoding as not given', async () => {
    writeFileSync(resolve(WS, 'a.txt'), 'one\ntwo\n')
    const meta = JSON.parse(await read({ path: 'a.txt', unit: '', encoding: '' }))
    expect(meta.content).toBe('one\ntwo\n')
    expect(meta.unit).toBe('lines')
    expect(meta.encoding).toBe('utf-8')
  })

  it('reports a missing file and refuses dotpaths', async () => {
    expect(await read({ path: 'nope.txt' })).toMatch(/not found/)
    expect(await read({ path: '.hidden/x' })).toMatch(/dotfile/)
  })
})
