import { describe, it, expect } from 'vitest'
import { composeSystem } from '../src/core/system-prompt.js'

describe('composeSystem', () => {
  it('returns empty array for empty slots', () => {
    expect(composeSystem({})).toEqual([])
    expect(composeSystem()).toEqual([])
  })

  it('returns one cached block for identity only', () => {
    const blocks = composeSystem({ identity: 'You are a helpful assistant.' })
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toContain('You are a helpful assistant.')
    expect(blocks[0].cache).toBe('5m')
  })

  it('concatenates identity + rules into one foundation block', () => {
    const blocks = composeSystem({
      identity: 'IDENTITY',
      rules: 'RULES'
    })
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toContain('IDENTITY')
    expect(blocks[0].text).toContain('RULES')
    expect(blocks[0].text.indexOf('IDENTITY')).toBeLessThan(blocks[0].text.indexOf('RULES'))
    expect(blocks[0].cache).toBe('5m')
  })

  it('respects cacheTtl option', () => {
    const blocks = composeSystem(
      { identity: 'X' },
      { cacheTtl: '1h' }
    )
    expect(blocks[0].cache).toBe('1h')
  })

  it('rules alone (no identity) is still cached', () => {
    const blocks = composeSystem({ rules: 'RULES_ONLY' })
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toContain('RULES_ONLY')
    expect(blocks[0].cache).toBe('5m')
  })

  it('puts the note after the foundation, with no breakpoint of its own', () => {
    const blocks = composeSystem({ identity: 'I', note: 'NOTE' })
    expect(blocks).toHaveLength(2)
    expect(blocks[0].text).toContain('CACHED PREFIX BOUNDARY')
    expect(blocks[0].cache).toBe('5m')
    expect(blocks[1]).toEqual({ text: 'NOTE' })
  })
})
