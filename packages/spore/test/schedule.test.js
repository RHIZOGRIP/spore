import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { enqueue, readInbox, saidOf } from '../src/core/spore-dir.js'
import { dueOf, lastFired, parseSchedule, refuseScheduleWrite, survey } from '../src/core/schedule.js'

const EVERY_MINUTE = '---\nwhen: * * * * *\ntz: UTC\n---\n\nCheck the queue.\n'
const HOURLY = '---\nwhen: 0 * * * *\ntz: UTC\n---\n\nCheck the queue.\n'
const GRANT = { count: 2, interval: 3_600_000 }
const IDLE = { state: 'idle' }

let ws

const put = (name, source, { ago = 0 } = {}) => {
  const path = resolve(ws, 'schedules', `${name}.cmk`)
  mkdirSync(resolve(ws, 'schedules'), { recursive: true })
  writeFileSync(path, source)
  if (ago) {
    const then = new Date(Date.now() - ago)
    utimesSync(path, then, then)
  }
  return path
}

beforeEach(() => {
  ws = mkdtempSync(resolve(tmpdir(), 'spore-schedule-'))
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

describe('a schedule file', () => {
  it('parses through the addon', () => {
    expect(parseSchedule(HOURLY)).toMatchObject({ when: '0 * * * *', tz: 'UTC', message: 'Check the queue.' })
    expect(parseSchedule('---\nwhen: 0 * * * *\n---\nx\n').error).toMatch(/no tz/)
  })

  it('is due for its latest slot and not again', () => {
    const at = Date.parse('2026-09-28T07:30:00Z')
    expect(dueOf(HOURLY, { after: Date.parse('2026-09-28T05:00:00Z'), now: at }))
      .toEqual({ state: 'due', slot: '2026-09-28T07:00:00Z' })
    expect(dueOf(HOURLY, { after: Date.parse('2026-09-28T07:00:00Z'), now: at }))
      .toEqual({ state: 'later', next: '2026-09-28T08:00:00Z' })
  })
})

describe('the clock on the inbox', () => {
  it('records which schedule fired, for which slot, and says so to the agent', () => {
    enqueue(ws, 'Check the queue.', { schedule: { name: 'queue', due: '2026-09-28T07:00:00Z' } })
    enqueue(ws, 'and a person says this')
    const [fired, said] = readInbox(ws)
    expect(fired).toMatchObject({ schedule: 'queue', due: '2026-09-28T07:00:00Z' })
    expect(saidOf(fired)).toMatch(/^\[Said by the clock: schedule "queue", for 2026-09-28T07:00:00Z\. No one sent this just now\.\]\n\nCheck the queue\.$/)
    expect(said).toMatchObject({ schedule: null, due: null })
    expect(saidOf(said)).toBe('and a person says this')
  })

  it('is where the last firing is read back from', () => {
    enqueue(ws, 'x', { schedule: { name: 'queue', due: '2026-09-28T06:00:00Z' } })
    enqueue(ws, 'x', { schedule: { name: 'other', due: '2026-09-28T06:30:00Z' } })
    enqueue(ws, 'x', { schedule: { name: 'queue', due: '2026-09-28T07:00:00Z' } })
    expect(lastFired(ws).get('queue')).toBe('2026-09-28T07:00:00Z')
    expect(lastFired(ws).get('other')).toBe('2026-09-28T06:30:00Z')
  })
})

describe('where a workspace\'s schedules stand', () => {
  it('is due for a spore that can take a new turn', () => {
    put('queue', EVERY_MINUTE, { ago: 10 * 60_000 })
    const [row] = survey(ws, { spore: IDLE, grant: null })
    expect(row).toMatchObject({ name: 'queue', state: 'due', message: 'Check the queue.' })
  })

  it('waits for its first slot after it was written', () => {
    put('queue', HOURLY)
    expect(survey(ws, { spore: IDLE, grant: null })[0].state).toBe('later')
  })

  it('is not fired again for the slot it last fired for', () => {
    put('queue', EVERY_MINUTE, { ago: 10 * 60_000 })
    const now = Date.now()
    const [{ slot }] = survey(ws, { spore: IDLE, grant: null, now })
    enqueue(ws, 'x', { schedule: { name: 'queue', due: slot } })
    expect(survey(ws, { spore: IDLE, grant: null, now })[0].state).toBe('later')
  })

  it('is held while the spore is busy, waiting on a question, or failed', () => {
    put('queue', EVERY_MINUTE, { ago: 10 * 60_000 })
    const held = (spore) => survey(ws, { spore, grant: null })[0]
    expect(held({ state: 'running' })).toMatchObject({ state: 'held', why: 'running' })
    expect(held({ state: 'running', draining: true })).toMatchObject({ state: 'held', why: 'draining' })
    expect(held({ state: 'waiting' })).toMatchObject({ state: 'held', why: 'waiting' })
    expect(held({ state: 'failed' })).toMatchObject({ state: 'held', why: 'failed' })
    expect(held({ state: 'crashed' })).toMatchObject({ state: 'held', why: 'crashed' })
    for (const state of ['idle', 'wrapped', 'halted', 'cancelled']) expect(held({ state }).state).toBe('due')
  })

  it('refuses a file that does not parse, and says why', () => {
    put('broken', '---\nwhen: sometimes\ntz: UTC\n---\nx\n')
    expect(survey(ws, { spore: IDLE, grant: null })[0]).toMatchObject({ state: 'refused', why: expect.stringMatching(/not a cron expression/) })
  })

  it('holds a schedule that fires more often than the grant allows', () => {
    put('queue', EVERY_MINUTE, { ago: 10 * 60_000 })
    expect(survey(ws, { spore: IDLE, grant: GRANT })[0]).toMatchObject({ state: 'refused', why: expect.stringMatching(/1m apart at its closest/) })
  })

  it('holds every schedule when there are more than the grant allows', () => {
    for (const name of ['a', 'b', 'c']) put(name, HOURLY)
    const rows = survey(ws, { spore: IDLE, grant: GRANT })
    expect(rows.map(r => r.state)).toEqual(['held', 'held', 'held'])
    expect(rows[0].why).toBe('3 schedules, and this spore may keep 2')
  })
})

describe('the grant, counted on what fired', () => {
  const DAY = 24 * 3_600_000
  const oneShot = (at) => `---\nwhen: at ${new Date(at).toISOString()}\n---\n\nCheck.\n`
  const firing = (name) => enqueue(ws, 'Check.', { schedule: { name, due: new Date().toISOString() } }).inbox

  it('holds a one-shot that replaced a spent one inside the window, and fires it once the window has passed', () => {
    const start = Date.now()
    firing('once')
    put('again', oneShot(start + 60_000))
    const grant = { count: 1, interval: DAY }

    const [held] = survey(ws, { spore: IDLE, grant, now: start + 120_000 })
    expect(held).toMatchObject({ name: 'again', state: 'held' })
    expect(held.why).toMatch(/1 firing in the last 24h, and this spore may have 1/)

    expect(survey(ws, { spore: IDLE, grant, now: start + DAY + 120_000 })[0].state).toBe('due')
  })

  it('counts nothing when no grant bounds the directory', () => {
    const start = Date.now()
    firing('once')
    put('again', oneShot(start + 60_000))
    expect(survey(ws, { spore: IDLE, grant: null, now: start + 120_000 })[0].state).toBe('due')
  })

  it('lets as many fire in a window as the grant allows, across every schedule', () => {
    const start = Date.now()
    put('b', oneShot(start + 60_000))
    const grant = { count: 2, interval: 3_600_000 }
    firing('a')
    expect(survey(ws, { spore: IDLE, grant, now: start + 120_000 })[0].state).toBe('due')
    firing('b')
    put('c', oneShot(start + 60_000))
    expect(survey(ws, { spore: IDLE, grant, now: start + 120_000 }).find(row => row.name === 'c').state).toBe('held')
  })
})

describe('a schedule the agent writes', () => {
  const at = (name) => resolve(ws, 'schedules', name)

  it('is refused when it is not a schedule file', () => {
    expect(refuseScheduleWrite(ws, at('notes.md'), HOURLY, { grant: GRANT })).toMatch(/only <name>\.cmk files/)
    expect(refuseScheduleWrite(ws, at('deep/queue.cmk'), HOURLY, { grant: GRANT })).toMatch(/only <name>\.cmk files/)
  })

  it('is refused when it breaks the grant', () => {
    expect(refuseScheduleWrite(ws, at('queue.cmk'), HOURLY, { grant: GRANT })).toBeNull()
    expect(refuseScheduleWrite(ws, at('queue.cmk'), EVERY_MINUTE, { grant: GRANT })).toMatch(/held to at least 1h/)
    put('a', HOURLY)
    put('b', HOURLY)
    expect(refuseScheduleWrite(ws, at('c.cmk'), HOURLY, { grant: GRANT })).toMatch(/would make 3 schedules/)
    expect(refuseScheduleWrite(ws, at('a.cmk'), HOURLY, { grant: GRANT })).toBeNull()
  })

  it('does not count a one-shot whose time has passed', () => {
    put('a', HOURLY)
    put('b', '---\nwhen: at 2020-01-01T00:00:00Z\n---\nlong ago\n')
    expect(refuseScheduleWrite(ws, at('c.cmk'), HOURLY, { grant: GRANT })).toBeNull()
  })

  it('is refused when it would fire only in the past', () => {
    expect(refuseScheduleWrite(ws, at('once.cmk'), '---\nwhen: at 2020-01-01T00:00:00Z\n---\nx\n', { grant: GRANT })).toMatch(/already passed/)
  })
})
