import { describe, it, expect } from 'vitest'
import { SporeError } from '../src/observability/errors.js'

describe('SporeError', () => {
  it('sets all fields from options', () => {
    const err = new SporeError('path escapes workspace', {
      type: 'PATH_ESCAPE',
      detail: 'The agent tried to access a file outside the project directory.',
      severity: 'warn',
      context: { userPath: '../etc', workspace: '/tmp/ws' },
      retryable: false
    })

    expect(err.name).toBe('SporeError')
    expect(err.type).toBe('PATH_ESCAPE')
    expect(err.message).toBe('path escapes workspace')
    expect(err.detail).toBe('The agent tried to access a file outside the project directory.')
    expect(err.severity).toBe('warn')
    expect(err.context).toEqual({ userPath: '../etc', workspace: '/tmp/ws' })
    expect(err.retryable).toBe(false)
  })

  it('defaults severity to error and retryable to false', () => {
    const err = new SporeError('something failed')
    expect(err.severity).toBe('error')
    expect(err.retryable).toBe(false)
  })

  it('omits absent optional fields rather than setting undefined', () => {
    const err = new SporeError('something failed')
    expect('detail' in err).toBe(false)
    expect('type' in err).toBe(false)
    expect('context' in err).toBe(false)
  })

  it('preserves cause chain', () => {
    const root = new Error('root cause')
    const err = new SporeError('wrapper', { cause: root })
    expect(err.cause).toBe(root)
  })

  it('is an instance of Error', () => {
    const err = new SporeError('boom')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(SporeError)
  })

  it('round-trips through fromJSON', () => {
    const wire = {
      message: 'context length exceeded',
      type: 'CONTEXT_OVERFLOW',
      detail: 'prompt is too long',
      severity: 'warn',
      retryable: false
    }
    const err = SporeError.fromJSON(wire, { provider: 'anthropic' })
    expect(err.toJSON()).toEqual(wire)
    expect(err.context).toEqual({ provider: 'anthropic' })
  })
})

describe('toJSON', () => {
  it('keeps context in-process — never on the wire', () => {
    const err = new SporeError('path is empty', {
      type: 'PATH_EMPTY',
      detail: 'No file was specified.',
      context: { workspace: '/tmp/ws' }
    })
    const wire = err.toJSON()
    expect(wire).toEqual({
      message: 'path is empty',
      type: 'PATH_EMPTY',
      detail: 'No file was specified.',
      severity: 'error',
      retryable: false
    })
    expect('context' in wire).toBe(false)
  })

  it('survives JSON.stringify with severity intact', () => {
    const err = new SporeError('rate limited', { type: 'RATE_LIMIT', severity: 'warn', retryable: true })
    expect(JSON.parse(JSON.stringify(err))).toMatchObject({ type: 'RATE_LIMIT', severity: 'warn', retryable: true })
  })
})
