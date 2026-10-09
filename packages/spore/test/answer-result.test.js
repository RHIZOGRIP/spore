import { describe, it, expect, vi } from 'vitest'
import { accountUsage, resolveEmptyCompletion, MAX_EMPTY_RETRIES } from '../src/core/answer-result.js'

const silent = { warn () {}, info () {}, debug () {} }

function zeroUsage () {
  return { input: 0, output: 0, thinking: 0, cacheWrite: 0, cacheRead: 0, cost: 0 }
}

describe('accountUsage', () => {
  it('accumulates tokens + cost and emits a usage event', () => {
    const usage = zeroUsage()
    const events = []
    const emit = (e, d) => events.push([e, d])
    const res = { inputTokens: 100, outputTokens: 20, thinkingTokens: 5, cacheWriteInputTokens: 3, cacheReadInputTokens: 2, cost: 0.01 }
    const inTok = accountUsage(res, { usage, emit, modelId: 'm/x', elapsedMs: 42 })
    expect(inTok).toBe(100)
    expect(usage).toMatchObject({ input: 100, output: 20, thinking: 5, cacheWrite: 3, cacheRead: 2, cost: 0.01 })
    expect(events[0][0]).toBe('usage')
    expect(events[0][1]).toMatchObject({ model: 'm/x', input: 100, output: 20, cost: 0.01, elapsedMs: 42 })
  })

  it('accumulates across calls and tolerates missing fields', () => {
    const usage = zeroUsage()
    const emit = () => {}
    accountUsage({ inputTokens: 10 }, { usage, emit, modelId: 'm', elapsedMs: 1 })
    accountUsage({ outputTokens: 7, cost: 0.5 }, { usage, emit, modelId: 'm', elapsedMs: 1 })
    expect(usage).toMatchObject({ input: 10, output: 7, cost: 0.5 })
  })
})

describe('resolveEmptyCompletion', () => {
  it('returns false (final) for a real answer and appends nothing', () => {
    const appended = []
    const r = resolveEmptyCompletion({ output: 'Right' }, {
      emptyState: { retries: 0 }, emit: () => {}, append: (m) => appended.push(m), logger: silent, round: 0
    })
    expect(r).toBe(false)
    expect(appended).toHaveLength(0)
  })

  it('nudges (returns true) on blank/null output and appends placeholder + nudge', () => {
    for (const blank of ['', '   ', null, undefined]) {
      const appended = []
      const emptyState = { retries: 0 }
      const events = []
      const r = resolveEmptyCompletion({ output: blank }, {
        emptyState, emit: (e, d) => events.push(e), append: (m) => appended.push(m), logger: silent, round: 1
      })
      expect(r).toBe(true)
      expect(emptyState.retries).toBe(1)
      expect(appended.map(m => m.role)).toEqual(['assistant', 'user'])
      expect(/empty/i.test(appended[1].content)).toBe(true)
      expect(events).toContain('empty_completion')
    }
  })

  it('stops nudging once the cap is reached', () => {
    const emptyState = { retries: MAX_EMPTY_RETRIES }
    const appended = []
    const r = resolveEmptyCompletion({ output: '' }, {
      emptyState, emit: () => {}, append: (m) => appended.push(m), logger: silent, round: 9
    })
    expect(r).toBe(false)
    expect(appended).toHaveLength(0)
  })

  it('warns when nudging (visible, not silent)', () => {
    const logger = { warn: vi.fn() }
    resolveEmptyCompletion({ output: '' }, {
      emptyState: { retries: 0 }, emit: () => {}, append: () => {}, logger, round: 0
    })
    expect(logger.warn).toHaveBeenCalledOnce()
  })
})
