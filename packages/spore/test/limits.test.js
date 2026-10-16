import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { native } from '../src/native.js'
import { changeText, extendTurn, runningLines, wrapTurn } from '../src/core/limits.js'
import { runningLimits, statePath } from '../src/core/spore-dir.js'

const WS = resolve(dirname(fileURLToPath(import.meta.url)), '.limits-workspace')
const DEFINITION = '---\nname: w\nmodel: m/1\ntools: [read]\nrounds: [40, 45]\ncost: [0.50, 0.75]\nwall: [20m, 25m]\nextend.wall: 1h\n---\n\nYou work.\n'

const startRunning = () => {
  const turn = native.beginTurn(WS)
  const db = new DatabaseSync(statePath(WS))
  const add = db.prepare("INSERT INTO t_limits (turnId, at, dimension, soft, hard, why) VALUES (?, ?, ?, ?, ?, 'start')")
  for (const [dimension, soft, hard] of [['rounds', 40, 45], ['cost', 0.5, 0.75], ['wall', 1_200_000, 1_500_000]]) {
    add.run(turn, new Date().toISOString(), dimension, soft, hard)
  }
  db.close()
}

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
  writeFileSync(resolve(WS, 'spore.cmk'), DEFINITION)
})

afterEach(() => {
  rmSync(WS, { recursive: true, force: true })
})

describe('a running turn\'s limits', () => {
  it('cannot change when nothing is running', () => {
    expect(changeText(extendTurn(WS, 'wall', '30m'))).toBe('nothing is running')
  })

  it('are raised within extend, and refused past it or without it', () => {
    startRunning()
    expect(changeText(extendTurn(WS, 'wall', '30m'))).toBe('its wall now wraps at 50m and stops at 55m')
    expect(changeText(extendTurn(WS, 'wall', '10m'))).toBe('extend.wall is 1h, so it can be raised by 5m at most')
    expect(changeText(extendTurn(WS, 'cost', '1.00'))).toMatch(/grants no extend\.cost/)
    expect(() => extendTurn(WS, 'time', '1h')).toThrow(/not "time"/)
    expect(() => extendTurn(WS, 'wall', 'soon')).toThrow(/not an amount of wall/)
  })

  it('wrap sooner when asked, and never later', () => {
    startRunning()
    const wrapped = wrapTurn(WS)
    expect(changeText(wrapped)).toMatch(/^it wraps at \d+s into the turn, and still stops at 25m$/)
    expect(changeText(wrapped, { brief: true })).toMatch(/^it wraps at \d+s into the turn$/)
    expect(changeText(wrapTurn(WS, '2h'))).toBe('it already wraps by then')
    expect(() => wrapTurn(WS, 'later')).toThrow(/not a wait/)
    expect(runningLimits(WS).limits.wall).toMatchObject({ hard: 1_500_000, why: 'wrap' })
  })

  it('read as the turn stands, with how far each may be raised', () => {
    startRunning()
    extendTurn(WS, 'wall', '15m')
    const lines = runningLines(runningLimits(WS), { wall: 3_600_000 })
    expect(lines).toContain('rounds: wraps at 40 rounds, stops at 45 rounds')
    expect(lines.find(line => line.startsWith('wall:'))).toMatch(/^wall: \d+s in, wraps at 35m, stops at 40m — can be raised to 1h$/)
  })
})
