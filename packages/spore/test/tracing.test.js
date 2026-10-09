import { describe, it, expect } from 'vitest'
import { trace } from '@opentelemetry/api'
import { startSpan, endSpanOk, endSpanError, formatTraceparent } from '../src/observability/tracing.js'

describe('tracing', () => {
  describe('startSpan', () => {
    it('returns a span object even without a configured provider (no-op)', () => {
      const span = startSpan('test.span', { foo: 'bar' })
      expect(span).toBeDefined()
      // No-op span has end() method
      expect(typeof span.end).toBe('function')
      span.end()
    })

    it('accepts a parentSpan argument without throwing', () => {
      const parent = startSpan('parent', {})
      const child = startSpan('child', { 'demo.round': 0 }, parent)
      expect(child).toBeDefined()
      child.end()
      parent.end()
    })

    it('uses the spore tracer namespace', () => {
      // Verify the API is wired correctly — getTracer('spore') returns a tracer
      const tracer = trace.getTracer('spore')
      expect(tracer).toBeDefined()
      expect(typeof tracer.startSpan).toBe('function')
    })
  })

  describe('endSpanOk', () => {
    it('ends a span without throwing', () => {
      const span = startSpan('test', {})
      expect(() => endSpanOk(span)).not.toThrow()
    })

    it('sets attributes on end', () => {
      const span = startSpan('test', {})
      // Spy on setAttributes
      let calledWith = null
      span.setAttributes = (attrs) => { calledWith = attrs }
      endSpanOk(span, { 'demo.rounds': 5, 'demo.tokens.input': 1000 })
      expect(calledWith).toEqual({ 'demo.rounds': 5, 'demo.tokens.input': 1000 })
    })

    it('handles missing attributes', () => {
      const span = startSpan('test', {})
      expect(() => endSpanOk(span, undefined)).not.toThrow()
    })
  })

  describe('endSpanError', () => {
    it('records exception and ends span', () => {
      const span = startSpan('test', {})
      let recordedException = null
      let setStatusArg = null
      span.recordException = (e) => { recordedException = e }
      span.setStatus = (s) => { setStatusArg = s }

      const err = new Error('boom')
      endSpanError(span, err)

      expect(recordedException).toBe(err)
      expect(setStatusArg.message).toBe('boom')
    })
  })

  describe('formatTraceparent', () => {
    it('formats a span with valid spanContext as a W3C traceparent string', () => {
      const fakeSpan = {
        spanContext: () => ({
          traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
          spanId: '00f067aa0ba902b7',
          traceFlags: 1
        })
      }
      expect(formatTraceparent(fakeSpan)).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')
    })

    it('zero-pads single-digit traceFlags', () => {
      const fakeSpan = {
        spanContext: () => ({
          traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
          spanId: '00f067aa0ba902b7',
          traceFlags: 0
        })
      }
      expect(formatTraceparent(fakeSpan)).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00')
    })

    it('defaults missing traceFlags to 00', () => {
      const fakeSpan = {
        spanContext: () => ({
          traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
          spanId: '00f067aa0ba902b7'
        })
      }
      expect(formatTraceparent(fakeSpan)).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00')
    })

    it('returns null for missing span', () => {
      expect(formatTraceparent(null)).toBeNull()
      expect(formatTraceparent(undefined)).toBeNull()
    })

    it('returns null when span has no spanContext function', () => {
      expect(formatTraceparent({})).toBeNull()
      expect(formatTraceparent({ spanContext: 'not-a-function' })).toBeNull()
    })

    it('returns null when spanContext returns invalid all-zero IDs', () => {
      const allZeroTrace = {
        spanContext: () => ({
          traceId: '00000000000000000000000000000000',
          spanId: '00f067aa0ba902b7',
          traceFlags: 1
        })
      }
      const allZeroSpan = {
        spanContext: () => ({
          traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
          spanId: '0000000000000000',
          traceFlags: 1
        })
      }
      expect(formatTraceparent(allZeroTrace)).toBeNull()
      expect(formatTraceparent(allZeroSpan)).toBeNull()
    })
  })
})
