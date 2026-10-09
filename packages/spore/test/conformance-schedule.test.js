/**
 * How long a conformance run is given, and where it is kept.
 */

import { describe, it, expect } from 'vitest'

import { runDeadline } from '../conformance/schedule.js'
import { runDir } from '../conformance/record.js'

describe('how long a run is given', () => {
  const limitsOf = (item) => ({ wall: ['4m', item.wall] })

  it('is the longest case, once per wave, plus slack', () => {
    const at = runDeadline([{ wall: '5m' }, { wall: '2m' }, { wall: '5m' }], {
      concurrency: 2,
      limitsOf,
      now: 0,
      slackMs: 60_000
    })
    // Two waves of the longest hard wall, and a minute to stage them.
    expect(at).toBe(2 * 300_000 + 60_000)
  })

  it('grows when a case is allowed longer, rather than being a number chosen here', () => {
    const tight = runDeadline([{ wall: '2m' }], { concurrency: 8, limitsOf, now: 0 })
    const roomy = runDeadline([{ wall: '20m' }], { concurrency: 8, limitsOf, now: 0 })
    expect(roomy - tight).toBe(18 * 60_000)
  })
})

describe('where a run is kept', () => {
  const at = new Date('2026-09-10T16:52:11Z')

  it('names itself for when it ran and what it ran on', () => {
    expect(runDir('/runs', { at, model: 'anthropic/claude-opus-5' }))
      .toBe('/runs/20260910-1652-anthropic-claude-opus-5')
  })

  // A model id holds a `/`. Used as it is, one run becomes two directories, the outer
  // one shared with every other run from that vendor.
  it('keeps a vendor-prefixed model to one directory', () => {
    expect(runDir('/runs', { at, model: 'novita/minimax/minimax-m2.5-highspeed' }))
      .toBe('/runs/20260910-1652-novita-minimax-minimax-m2.5-highspeed')
  })

  it('gives two runs of the same model different homes when the minute differs', () => {
    const first = runDir('/runs', { at, model: 'm' })
    const later = runDir('/runs', { at: new Date('2026-09-10T17:03:00Z'), model: 'm' })
    expect(first).not.toBe(later)
  })
})
