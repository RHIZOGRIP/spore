import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { chmodSync, closeSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { paused, pauseSpores, takeSlot, unpauseSpores, withSlot } from '../src/core/admission.js'
import { send } from '../src/core/send.js'
import { CONFIG_FILE, readConfig, setKey, settings } from '../src/library/config.js'
import { enqueue, statePath } from '../src/core/spore-dir.js'

const run = promisify(execFile)
const RUNNER = resolve(dirname(fileURLToPath(import.meta.url)), '../native', process.arch, 'spore-runner')

let dir
beforeEach(() => {
  dir = resolve(tmpdir(), `spore-admission-${process.pid}-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(CONFIG_FILE, { force: true })
})

const configure = (config) => {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(config))
}
const turns = (count) => configure({ turns: count })

describe('admission slots', () => {
  it('hands out a different slot to each holder', () => {
    turns(2)
    const one = takeSlot(CONFIG_FILE)
    const two = takeSlot(CONFIG_FILE)
    expect(one.path).not.toBe(two.path)
    closeSync(one.fd)
    closeSync(two.fd)
  })

  it('refuses once every slot is held, and frees one when its holder lets go', () => {
    turns(1)
    const one = takeSlot(CONFIG_FILE)
    expect(() => takeSlot(CONFIG_FILE)).toThrow(expect.objectContaining({ type: 'ADMISSION_FULL', retryable: true }))
    closeSync(one.fd)
    const again = takeSlot(CONFIG_FILE)
    expect(again.path).toBe(one.path)
    closeSync(again.fd)
  })

  it('holds a slot for what runs with it, and lets it go however that ends', () => {
    turns(1)
    expect(() => withSlot(CONFIG_FILE, () => {
      expect(() => takeSlot(CONFIG_FILE)).toThrow(expect.objectContaining({ type: 'ADMISSION_FULL' }))
      throw new Error('the runner did not start')
    })).toThrow('the runner did not start')
    expect(withSlot(CONFIG_FILE, (slot) => slot.path)).toMatch(/./)
    closeSync(takeSlot(CONFIG_FILE).fd)
  })

  it('gives no slot while spores are paused, and keeps the first mark', () => {
    expect(paused()).toBe(null)
    const first = pauseSpores({ why: 'alerts storm' })
    expect(first).toMatchObject({ already: false, mark: { why: 'alerts storm' } })
    expect(paused()).toEqual(first.mark)
    expect(() => takeSlot(CONFIG_FILE)).toThrow(expect.objectContaining({ type: 'PAUSED', detail: expect.stringMatching(/alerts storm.*spore unpause/) }))
    expect(pauseSpores({ why: 'again' })).toEqual({ already: true, mark: first.mark })
    expect(unpauseSpores()).toBe(true)
    expect(unpauseSpores()).toBe(false)
    closeSync(takeSlot(CONFIG_FILE).fd)
  })

  it('counts only the slots the limit names, so lowering it binds at once', () => {
    turns(3)
    const held = [takeSlot(CONFIG_FILE), takeSlot(CONFIG_FILE)]
    turns(2)
    expect(() => takeSlot(CONFIG_FILE)).toThrow(/2 of your turns are already running/)
    for (const slot of held) closeSync(slot.fd)
  })

  it('a runner started without one refuses before it opens anything', async () => {
    const failed = await run(RUNNER, ['--ws', dir], { env: { PATH: process.env.PATH } }).catch(e => e)
    expect(failed.code).toBe(2)
    expect(failed.stderr).toMatch(/admission slot/)
  })

  it('a runner given a slot and told its caller admits it refuses both', async () => {
    const failed = await run(RUNNER, ['--ws', dir, '--slot', resolve(dir, 'slot'), '--caller-admits'], { env: { PATH: process.env.PATH } }).catch(e => e)
    expect(failed.code).toBe(2)
    expect(failed.stderr).toMatch(/admission slot or its caller admits it, not both/)
  })

  it('a runner its caller admits needs no slot on fd 3', async () => {
    const failed = await run(RUNNER, ['--ws', dir, '--caller-admits'], { env: { PATH: process.env.PATH } }).catch(e => e)
    expect(failed.code).toBe(2)
    expect(failed.stderr).not.toMatch(/admission slot/)
    expect(failed.stderr).toMatch(/which node/)
  })

  it('gets its slot back from a send whose message could not be written', () => {
    const ws = resolve(dir, 'ws')
    mkdirSync(ws, { recursive: true })
    enqueue(ws, 'said before')
    chmodSync(statePath(ws), 0o444)

    turns(1)
    expect(() => send(ws, 'hello')).toThrow(expect.objectContaining({ type: 'INBOX_UNWRITABLE' }))
    const again = takeSlot(CONFIG_FILE)
    closeSync(again.fd)
  })
})

describe('caller admission', () => {
  it('takes no slot however many turns start, and is still refused while paused', () => {
    configure({ admission: 'caller' })
    const taken = Array.from({ length: 12 }, () => takeSlot(CONFIG_FILE))
    expect(taken.every(slot => slot.fd === null && slot.path === null)).toBe(true)
    expect(withSlot(CONFIG_FILE, (slot) => slot.fd)).toBe(null)

    pauseSpores({ why: 'alerts storm' })
    expect(() => takeSlot(CONFIG_FILE)).toThrow(expect.objectContaining({ type: 'PAUSED', detail: expect.stringMatching(/alerts storm.*spore unpause/) }))
    unpauseSpores()
  })

  it('refuses a turns count beside it, and an admission it does not know', () => {
    configure({ admission: 'caller', turns: 8 })
    expect(() => readConfig(CONFIG_FILE)).toThrow(expect.objectContaining({ type: 'CONFIG_INVALID', message: expect.stringMatching(/has a turns, and its caller admits turns/) }))
    configure({ admission: 'scheduler' })
    expect(() => readConfig(CONFIG_FILE)).toThrow(expect.objectContaining({ type: 'CONFIG_INVALID', message: expect.stringMatching(/admission that is not spore or caller/) }))
  })

  it('is set by name, and shows no turns count while it holds', () => {
    configure({})
    expect(settings(CONFIG_FILE).find(row => row.key === 'admission')).toEqual({ key: 'admission', value: 'spore', from: 'default' })
    setKey('admission', 'caller', CONFIG_FILE)
    expect(readConfig(CONFIG_FILE).admission).toBe('caller')
    const shown = settings(CONFIG_FILE)
    expect(shown.find(row => row.key === 'admission')).toEqual({ key: 'admission', value: 'caller', from: 'set' })
    expect(shown.find(row => row.key === 'turns')).toEqual({ key: 'turns', value: null, from: 'unset' })
    expect(() => setKey('admission', 'managed', CONFIG_FILE)).toThrow(expect.objectContaining({ type: 'CONFIG_INVALID' }))
    expect(() => setKey('turns', '4', CONFIG_FILE)).toThrow(expect.objectContaining({ type: 'CONFIG_INVALID' }))
  })
})
