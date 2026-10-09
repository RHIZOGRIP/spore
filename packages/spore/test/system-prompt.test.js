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

  it('concatenates identity + domainRules into one foundation block', () => {
    const blocks = composeSystem({
      identity: 'IDENTITY',
      domainRules: 'RULES'
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

  it('puts substrate in its own cached block after foundation', () => {
    const blocks = composeSystem({
      identity: 'I',
      substrate: 'SUBSTRATE'
    })
    expect(blocks).toHaveLength(2)
    expect(blocks[0].text).toContain('I')
    expect(blocks[0].cache).toBe('5m')
    expect(blocks[1].text).toContain('SUBSTRATE')
    expect(blocks[1].cache).toBe('5m')
  })

  it('emits substrate, sessionMemory, and dynamic each in their own block', () => {
    const blocks = composeSystem({
      identity: 'I',
      substrate: 'S',
      sessionMemory: 'MEM',
      dynamic: 'DYN'
    })
    expect(blocks).toHaveLength(4)
    expect(blocks[0].cache).toBe('5m') // foundation
    expect(blocks[1].cache).toBe('5m') // substrate
    expect(blocks[1].text).toContain('S')
    expect(blocks[2].cache).toBe('5m') // sessionMemory — its own breakpoint
    expect(blocks[2].text).toContain('MEM')
    expect(blocks[3].cache).toBeUndefined() // dynamic string — uncached tail
    expect(blocks[3].text).toContain('DYN')
  })

  it('promotes sessionMemory to a cached block of its own', () => {
    const blocks = composeSystem({
      identity: 'I',
      sessionMemory: 'MEM'
    })
    expect(blocks).toHaveLength(2)
    expect(blocks[0].text).toContain('I')
    expect(blocks[0].cache).toBe('5m')
    expect(blocks[1].text).toContain('MEM')
    expect(blocks[1].cache).toBe('5m')
  })

  it('domainRules alone (no identity) is still cached', () => {
    const blocks = composeSystem({ domainRules: 'RULES_ONLY' })
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toContain('RULES_ONLY')
    expect(blocks[0].cache).toBe('5m')
  })

  it('substrate alone (no foundation) is still cached', () => {
    const blocks = composeSystem({ substrate: 'S' })
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toContain('S')
    expect(blocks[0].cache).toBe('5m')
  })

  it('dynamic alone (no foundation, no substrate) is uncached', () => {
    const blocks = composeSystem({ dynamic: 'DYN' })
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toContain('DYN')
    expect(blocks[0].cache).toBeUndefined()
  })

  it('ignores slot order in input — output order is canonical', () => {
    const a = composeSystem({
      dynamic: 'D',
      substrate: 'S',
      identity: 'I',
      sessionMemory: 'M',
      domainRules: 'R'
    })
    const b = composeSystem({
      identity: 'I',
      domainRules: 'R',
      substrate: 'S',
      sessionMemory: 'M',
      dynamic: 'D'
    })
    expect(a).toEqual(b)
  })

  // ── caller-composable dynamic array (D) ──────────────────────────

  it('accepts dynamic as an array of {text, cache?} blocks', () => {
    const blocks = composeSystem({
      identity: 'I',
      dynamic: [
        { text: 'per-thread state', cache: '5m' },
        { text: 'per-turn delta' } // no cache → uncached
      ]
    })
    expect(blocks).toHaveLength(3)
    expect(blocks[0].cache).toBe('5m') // foundation
    expect(blocks[1].text).toBe('per-thread state')
    expect(blocks[1].cache).toBe('5m')
    expect(blocks[2].text).toBe('per-turn delta')
    expect(blocks[2].cache).toBeUndefined()
  })

  it('caller dynamic array supports 1h cache hint', () => {
    const blocks = composeSystem({
      dynamic: [{ text: 'tenant config', cache: '1h' }]
    })
    expect(blocks[0].cache).toBe('1h')
  })

  it('skips empty/blank entries in dynamic array', () => {
    const blocks = composeSystem({
      identity: 'I',
      dynamic: [
        { text: 'real', cache: '5m' },
        { text: '' },
        null,
        undefined,
        { text: 'tail' }
      ]
    })
    // foundation + two surviving caller blocks
    expect(blocks).toHaveLength(3)
    expect(blocks[1].text).toBe('real')
    expect(blocks[2].text).toBe('tail')
  })

  it('ignores invalid cache hints (only 5m/1h accepted)', () => {
    const blocks = composeSystem({
      dynamic: [
        { text: 'a', cache: '2m' },
        { text: 'b', cache: true },
        { text: 'c' }
      ]
    })
    expect(blocks).toHaveLength(3)
    expect(blocks[0].cache).toBeUndefined()
    expect(blocks[1].cache).toBeUndefined()
    expect(blocks[2].cache).toBeUndefined()
  })

  it('empty dynamic array adds no blocks', () => {
    const blocks = composeSystem({ identity: 'I', dynamic: [] })
    expect(blocks).toHaveLength(1)
  })

  it('substrate omitted when empty (no useless cache breakpoint)', () => {
    const blocks = composeSystem({ identity: 'I', substrate: '' })
    expect(blocks).toHaveLength(1)
  })

  it('sessionMemory omitted when empty (no useless cache breakpoint)', () => {
    const blocks = composeSystem({ identity: 'I', sessionMemory: '' })
    expect(blocks).toHaveLength(1)
  })

  it('embeds visible boundary markers between tiers', () => {
    const blocks = composeSystem({
      identity: 'I',
      substrate: 'S',
      sessionMemory: 'M'
    })
    // Foundation block ends with the cached-prefix boundary marker
    expect(blocks[0].text).toContain('CACHED PREFIX BOUNDARY')
    // Substrate block ends with the cache-fresh boundary marker
    expect(blocks[1].text).toContain('CACHE-FRESH')
  })
})
