import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { chmodSync, closeSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { paused, pauseSpores, takeSlot, unpauseSpores, withSlot } from '../src/core/admission.js'
import { send } from '../src/core/send.js'
import { CONFIG_FILE } from '../src/library/config.js'
import { enqueue, statePath } from '../src/core/spore-dir.js'

const run = promisify(execFile)
const RUNNER = resolve(dirname(fileURLToPath(import.meta.url)), '../native/spore-runner')

let dir
beforeEach(() => {
  dir = resolve(tmpdir(), `spore-admission-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('admission slots', () => {
  it('hands out a different slot to each holder', () => {
    const one = takeSlot({ turns: 2, dir })
    const two = takeSlot({ turns: 2, dir })
    expect(one.path).not.toBe(two.path)
    closeSync(one.fd)
    closeSync(two.fd)
  })

  it('refuses once every slot is held, and frees one when its holder lets go', () => {
    const one = takeSlot({ turns: 1, dir })
    expect(() => takeSlot({ turns: 1, dir })).toThrow(expect.objectContaining({ type: 'ADMISSION_FULL', retryable: true }))
    closeSync(one.fd)
    const again = takeSlot({ turns: 1, dir })
    expect(again.path).toBe(one.path)
    closeSync(again.fd)
  })

  it('holds a slot for what runs with it, and lets it go however that ends', () => {
    expect(() => withSlot(() => {
      expect(() => takeSlot({ turns: 1, dir })).toThrow(expect.objectContaining({ type: 'ADMISSION_FULL' }))
      throw new Error('the runner did not start')
    }, { turns: 1, dir })).toThrow('the runner did not start')
    expect(withSlot((slot) => slot.path, { turns: 1, dir })).toMatch(/./)
    closeSync(takeSlot({ turns: 1, dir }).fd)
  })

  it('gives no slot while spores are paused, and keeps the first mark', () => {
    const slots = resolve(dir, 'slots')
    expect(paused({ dir: slots })).toBe(null)
    const first = pauseSpores({ why: 'alerts storm', dir: slots })
    expect(first).toMatchObject({ already: false, mark: { why: 'alerts storm' } })
    expect(paused({ dir: slots })).toEqual(first.mark)
    expect(() => takeSlot({ turns: 2, dir: slots })).toThrow(expect.objectContaining({ type: 'PAUSED', detail: expect.stringMatching(/alerts storm.*spore unpause/) }))
    expect(pauseSpores({ why: 'again', dir: slots })).toEqual({ already: true, mark: first.mark })
    expect(unpauseSpores({ dir: slots })).toBe(true)
    expect(unpauseSpores({ dir: slots })).toBe(false)
    closeSync(takeSlot({ turns: 2, dir: slots }).fd)
  })

  it('counts only the slots the limit names, so lowering it binds at once', () => {
    const held = [takeSlot({ turns: 3, dir }), takeSlot({ turns: 3, dir })]
    expect(() => takeSlot({ turns: 2, dir })).toThrow(/2 of your turns are already running/)
    for (const slot of held) closeSync(slot.fd)
  })

  it('a runner started without one refuses before it opens anything', async () => {
    const failed = await run(RUNNER, ['--ws', dir], { env: { PATH: process.env.PATH } }).catch(e => e)
    expect(failed.code).toBe(2)
    expect(failed.stderr).toMatch(/admission slot/)
  })

  it('gets its slot back from a send whose message could not be written', () => {
    const ws = resolve(dir, 'ws')
    mkdirSync(ws, { recursive: true })
    enqueue(ws, 'said before')
    chmodSync(statePath(ws), 0o444)

    mkdirSync(dirname(CONFIG_FILE), { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify({ turns: 1 }))
    try {
      expect(() => send(ws, 'hello')).toThrow(expect.objectContaining({ type: 'INBOX_UNWRITABLE' }))
      const again = takeSlot()
      closeSync(again.fd)
    } finally {
      rmSync(CONFIG_FILE, { force: true })
    }
  })
})
