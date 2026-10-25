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
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(CONFIG_FILE, { force: true })
})

const turns = (count) => {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify({ turns: count }))
}

describe('admission slots', () => {
  it('hands out a different slot to each holder', () => {
    turns(2)
    const one = takeSlot()
    const two = takeSlot()
    expect(one.path).not.toBe(two.path)
    closeSync(one.fd)
    closeSync(two.fd)
  })

  it('refuses once every slot is held, and frees one when its holder lets go', () => {
    turns(1)
    const one = takeSlot()
    expect(() => takeSlot()).toThrow(expect.objectContaining({ type: 'ADMISSION_FULL', retryable: true }))
    closeSync(one.fd)
    const again = takeSlot()
    expect(again.path).toBe(one.path)
    closeSync(again.fd)
  })

  it('holds a slot for what runs with it, and lets it go however that ends', () => {
    turns(1)
    expect(() => withSlot(() => {
      expect(() => takeSlot()).toThrow(expect.objectContaining({ type: 'ADMISSION_FULL' }))
      throw new Error('the runner did not start')
    })).toThrow('the runner did not start')
    expect(withSlot((slot) => slot.path)).toMatch(/./)
    closeSync(takeSlot().fd)
  })

  it('gives no slot while spores are paused, and keeps the first mark', () => {
    expect(paused()).toBe(null)
    const first = pauseSpores({ why: 'alerts storm' })
    expect(first).toMatchObject({ already: false, mark: { why: 'alerts storm' } })
    expect(paused()).toEqual(first.mark)
    expect(() => takeSlot()).toThrow(expect.objectContaining({ type: 'PAUSED', detail: expect.stringMatching(/alerts storm.*spore unpause/) }))
    expect(pauseSpores({ why: 'again' })).toEqual({ already: true, mark: first.mark })
    expect(unpauseSpores()).toBe(true)
    expect(unpauseSpores()).toBe(false)
    closeSync(takeSlot().fd)
  })

  it('counts only the slots the limit names, so lowering it binds at once', () => {
    turns(3)
    const held = [takeSlot(), takeSlot()]
    turns(2)
    expect(() => takeSlot()).toThrow(/2 of your turns are already running/)
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

    turns(1)
    expect(() => send(ws, 'hello')).toThrow(expect.objectContaining({ type: 'INBOX_UNWRITABLE' }))
    const again = takeSlot()
    closeSync(again.fd)
  })
})
