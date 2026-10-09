import { describe, it, expect } from 'vitest'
import { silent, cliLogger } from '../src/observability/logger.js'

describe('silent logger', () => {
  it('has all level methods', () => {
    expect(typeof silent.trace).toBe('function')
    expect(typeof silent.debug).toBe('function')
    expect(typeof silent.info).toBe('function')
    expect(typeof silent.warn).toBe('function')
    expect(typeof silent.error).toBe('function')
    expect(typeof silent.fatal).toBe('function')
  })

  it('all methods are no-ops', () => {
    expect(() => silent.info('hello', { extra: 1 })).not.toThrow()
    expect(silent.info('hello')).toBeUndefined()
  })

  it('child returns a logger of the same shape', () => {
    const child = silent.child({ span: { id: 'abc' } })
    expect(typeof child.trace).toBe('function')
    expect(typeof child.child).toBe('function')
    expect(() => child.info('msg')).not.toThrow()
  })

  it('child is callable repeatedly', () => {
    const a = silent.child({ x: 1 })
    const b = a.child({ y: 2 })
    expect(typeof b.info).toBe('function')
  })
})

describe('cliLogger', () => {
  it('has all level methods', () => {
    const lg = cliLogger()
    expect(typeof lg.trace).toBe('function')
    expect(typeof lg.debug).toBe('function')
    expect(typeof lg.info).toBe('function')
    expect(typeof lg.warn).toBe('function')
    expect(typeof lg.error).toBe('function')
    expect(typeof lg.fatal).toBe('function')
    expect(typeof lg.child).toBe('function')
  })

  it('child returns the same logger instance', () => {
    const lg = cliLogger()
    const child = lg.child({ span: { id: 'abc' } })
    expect(child).toBe(lg)
  })

  it('child is callable without throwing', () => {
    const lg = cliLogger()
    expect(() => lg.child({ x: 1 }).info('msg')).not.toThrow()
  })
})

describe('logger compatibility for span binding', () => {
  it('spore code can call .child({ span }) on any provided logger without checks', () => {
    // Mimics how worker code binds: logger = logger.child({ span })
    let logger = silent
    const fakeSpan = { spanContext: () => ({ traceId: 'abc', spanId: '123' }) }
    expect(() => { logger = logger.child({ span: fakeSpan }) }).not.toThrow()
    expect(typeof logger.info).toBe('function')
  })
})
