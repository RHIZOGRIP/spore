import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { withRecovery } from '../src/resilience/recovery.js'
import { createSessionMemory } from '../src/resilience/session-memory.js'
import { SporeError } from '../src/observability/errors.js'
import { MohdelError } from 'mohdel/errors'

function mockModel (behavior) {
  let callCount = 0
  return {
    info: () => ({ contextTokenLimit: 100000 }),
    id: 'test/model',
    answer: async () => {
      callCount++
      return behavior(callCount)
    },
    get callCount () { return callCount }
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// Every wait recovery takes, run to its end on the fake clock.
const onTheClock = async (answering) => {
  answering.catch(() => {})
  await vi.runAllTimersAsync()
  return answering
}

/** Build the flat wire shape: machine key on `type`, label on `message`. */
function typedError (type, { retryable = false, detail = '', status } = {}) {
  const err = new Error(type.toLowerCase().replace(/_/g, ' '))
  err.type = type
  err.detail = detail
  err.retryable = retryable
  if (status) err.status = status
  return err
}

describe('recovery supervisor', () => {
  it('passes through on success', async () => {
    const model = mockModel(() => ({ status: 'completed', output: 'ok' }))
    const wrapped = withRecovery(model, { messages: [] })
    const res = await onTheClock(wrapped.answer({}, {}))
    expect(res.output).toBe('ok')
    expect(model.callCount).toBe(1)
  })

  it('retries retryable errors', async () => {
    const model = mockModel((n) => {
      if (n <= 2) {
        const err = new Error('rate limit exceeded')
        err.retryable = true
        throw err
      }
      return { status: 'completed', output: 'recovered' }
    })
    const wrapped = withRecovery(model, { messages: [] })
    const res = await onTheClock(wrapped.answer({}, {}))
    expect(res.output).toBe('recovered')
    expect(model.callCount).toBe(3)
  })

  it('emits a recovery event before each retry backoff', async () => {
    const model = mockModel((n) => {
      if (n <= 2) throw typedError('PROVIDER_RETRYABLE_ERROR', { retryable: true, detail: 'ECONNRESET' })
      return { status: 'completed', output: 'recovered' }
    })
    const events = []
    const emitter = { emit: (type, data) => events.push({ type, data }) }
    const wrapped = withRecovery(model, { messages: [], emitter })
    await onTheClock(wrapped.answer({}, {}))
    const retries = events.filter(e => e.type === 'recovery' && e.data.action === 'retry')
    expect(retries).toEqual([
      { type: 'recovery', data: { action: 'retry', reason: 'PROVIDER_RETRYABLE_ERROR', attempt: 1, delay: 1000 } },
      { type: 'recovery', data: { action: 'retry', reason: 'PROVIDER_RETRYABLE_ERROR', attempt: 2, delay: 2000 } }
    ])
  })

  it('emits a recovery event for the unknown-error retry', async () => {
    const model = mockModel((n) => {
      if (n === 1) throw new Error('socket hang up')
      return { status: 'completed', output: 'recovered' }
    })
    const events = []
    const emitter = { emit: (type, data) => events.push({ type, data }) }
    const wrapped = withRecovery(model, { messages: [], emitter })
    await onTheClock(wrapped.answer({}, {}))
    expect(events).toContainEqual({
      type: 'recovery',
      data: { action: 'retry', reason: 'UNEXPECTED_ERROR', attempt: 1, delay: 1000 }
    })
  })

  it('retries on 429 status', async () => {
    const model = mockModel((n) => {
      if (n === 1) {
        const err = new Error('Too Many Requests')
        err.status = 429
        throw err
      }
      return { status: 'completed', output: 'ok' }
    })
    const wrapped = withRecovery(model, { messages: [] })
    const res = await onTheClock(wrapped.answer({}, {}))
    expect(res.output).toBe('ok')
    expect(model.callCount).toBe(2)
  })

  it('retries on connection errors', async () => {
    const model = mockModel((n) => {
      if (n === 1) throw typedError('PROVIDER_ERROR', { retryable: true, detail: 'ECONNRESET' })
      return { status: 'completed', output: 'ok' }
    })
    const wrapped = withRecovery(model, { messages: [] })
    const res = await onTheClock(wrapped.answer({}, {}))
    expect(res.output).toBe('ok')
  })

  it('throws immediately on auth errors', async () => {
    const model = mockModel(() => {
      const err = new Error('Unauthorized')
      err.status = 401
      throw err
    })
    const wrapped = withRecovery(model, { messages: [] })
    await expect(onTheClock(wrapped.answer({}, {}))).rejects.toThrow('Unauthorized')
    expect(model.callCount).toBe(1)
  })

  it('throws immediately on 400 bad request', async () => {
    const model = mockModel(() => {
      const err = new Error('Bad Request')
      err.status = 400
      throw err
    })
    const wrapped = withRecovery(model, { messages: [] })
    await expect(onTheClock(wrapped.answer({}, {}))).rejects.toThrow('Bad Request')
    expect(model.callCount).toBe(1)
  })

  it('compacts on context overflow then retries', async () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: 'x'.repeat(80000) }
    ]
    let callCount = 0
    const model = {
      info: () => ({ contextTokenLimit: 5000 }),
      id: 'test/model',
      answer: async () => {
        callCount++
        if (callCount === 1) throw typedError('CONTEXT_OVERFLOW', { detail: 'context length exceeded' })
        return { status: 'completed', output: 'ok after compact' }
      }
    }
    const wrapped = withRecovery(model, { messages })
    const res = await onTheClock(wrapped.answer({}, {}))
    expect(res.output).toBe('ok after compact')
    // Tool result should be compacted
    expect(messages[2].content).toMatch(/compacted/)
  })

  it('waits out a refusal that names its wait, spending no retry on it', async () => {
    const cooling = () => {
      const err = typedError('PROVIDER_COOLDOWN', { retryable: true, detail: 'chatgpt is in cooldown for 1s' })
      err.retryAfterMs = 60
      return err
    }
    const model = mockModel((n) => {
      if (n <= 3) throw typedError('NET_ERROR', { retryable: true })
      if (n === 4) throw cooling()
      return { status: 'completed', output: 'after the cooldown' }
    })
    const events = []
    const wrapped = withRecovery(model, { messages: [], emitter: { emit: (type, data) => events.push({ type, data }) } })
    const started = Date.now()
    const res = await onTheClock(wrapped.answer({}, {}))
    expect(res.output).toBe('after the cooldown')
    expect(Date.now() - started).toBeGreaterThanOrEqual(60)
    expect(events.filter(e => e.type === 'recovery').map(e => e.data.action)).toEqual(['retry', 'retry', 'retry', 'wait'])
    expect(events.find(e => e.data.action === 'wait').data).toEqual({ action: 'wait', reason: 'PROVIDER_COOLDOWN', delay: 60 })
  })

  it('stops waiting when the turn is stopped', async () => {
    const stop = new AbortController()
    const model = mockModel(() => {
      const err = typedError('PROVIDER_COOLDOWN', { retryable: true })
      err.retryAfterMs = 60_000
      throw err
    })
    const wrapped = withRecovery(model, { messages: [], signal: stop.signal })
    setTimeout(() => stop.abort(), 30)
    const started = Date.now()
    const ended = wrapped.answer({}, {}).then(() => null, () => Date.now() - started)
    await vi.runAllTimersAsync()
    expect(await ended).toBeLessThan(5_000)
    expect(model.callCount).toBe(1)
  })

  it('still gives up when the provider keeps failing between waits', async () => {
    const model = mockModel((n) => {
      if (n % 2 === 0) {
        const err = typedError('PROVIDER_COOLDOWN', { retryable: true })
        err.retryAfterMs = 5
        throw err
      }
      throw typedError('NET_ERROR', { retryable: true })
    })
    const wrapped = withRecovery(model, { messages: [] })
    await expect(onTheClock(wrapped.answer({}, {}))).rejects.toMatchObject({ type: 'NET_ERROR' })
    expect(model.callCount).toBe(7)
  })

  it('gives up after max retries on retryable errors', async () => {
    const model = mockModel(() => {
      const err = new Error('overloaded')
      err.retryable = true
      throw err
    })
    const wrapped = withRecovery(model, { messages: [] })
    await expect(onTheClock(wrapped.answer({}, {}))).rejects.toThrow('overloaded')
    expect(model.callCount).toBe(4) // 1 initial + 3 retries
  })

  it('emits bracket log lines around each retry', async () => {
    // Captures log entries so we can assert ordering. Mirrors the
    // pino-compatible shape spore loggers use (`{ msg, ...fields }`).
    const lines = []
    const capture = {
      child: () => capture,
      trace: () => {},
      debug: (obj, msg) => lines.push({ level: 'debug', msg, ...obj }),
      info: (obj, msg) => lines.push({ level: 'info', msg, ...obj }),
      warn: (obj, msg) => lines.push({ level: 'warn', msg, ...obj }),
      error: () => {},
      fatal: () => {}
    }
    const model = mockModel((n) => {
      if (n <= 2) {
        const err = new Error('temporary')
        err.retryable = true
        throw err
      }
      return { status: 'completed', output: 'recovered' }
    })
    const wrapped = withRecovery(model, { messages: [], logger: capture })
    await onTheClock(wrapped.answer({}, {}))

    // Two `retryable error` lines (one per failure), two `retry firing`
    // lines (one per retry attempt), one `retry succeeded` line at the
    // end. Order matters: each retry's bracket interleaves
    // error → firing → (success | next error).
    const sequence = lines
      .map(l => l.msg)
      .filter(m => m?.startsWith('[recovery]'))
    expect(sequence).toEqual([
      '[recovery] retryable error, waiting',
      '[recovery] retry firing',
      '[recovery] retryable error, waiting',
      '[recovery] retry firing',
      '[recovery] retry succeeded'
    ])
  })

  it('retries unknown errors once', async () => {
    const model = mockModel((n) => {
      if (n === 1) throw new Error('something weird')
      return { status: 'completed', output: 'ok' }
    })
    const wrapped = withRecovery(model, { messages: [] })
    const res = await onTheClock(wrapped.answer({}, {}))
    expect(res.output).toBe('ok')
    expect(model.callCount).toBe(2)
  })

  it('throws unknown errors after one retry', async () => {
    const model = mockModel(() => { throw new Error('persistent weird error') })
    const wrapped = withRecovery(model, { messages: [] })
    await expect(onTheClock(wrapped.answer({}, {}))).rejects.toThrow('persistent weird error')
    expect(model.callCount).toBe(2) // 1 initial + 1 retry
  })

  it('preserves model info and id', () => {
    const model = {
      info: () => ({ contextTokenLimit: 50000, label: 'Test' }),
      id: 'test/model',
      answer: async () => ({})
    }
    const wrapped = withRecovery(model, { messages: [] })
    expect(wrapped.info().label).toBe('Test')
    expect(wrapped.id).toBe('test/model')
  })

  it('logs recovery actions', async () => {
    const logged = []
    const model = mockModel((n) => {
      if (n === 1) {
        const err = new Error('rate limit')
        err.retryable = true
        throw err
      }
      return { status: 'completed', output: 'ok' }
    })
    const wrapped = withRecovery(model, {
      messages: [],
      logger: {
        debug () {},
        info () {},
        warn: (...a) => logged.push(a.join(' ')),
        error: (...a) => logged.push(a.join(' '))
      }
    })
    await onTheClock(wrapped.answer({}, {}))
    expect(logged.some(l => l.includes('retryable'))).toBe(true)
  })

  // ── Iterative compaction ───────────────────────────────────────

  it('compacts tool_results on overflow then succeeds', async () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: 'x'.repeat(80000) }
    ]
    let callCount = 0
    const model = {
      info: () => ({ contextTokenLimit: 5000 }),
      id: 'test/model',
      answer: async () => {
        callCount++
        if (callCount === 1) throw typedError('CONTEXT_OVERFLOW', { detail: 'context exceeded' })
        return { status: 'completed', output: 'ok' }
      }
    }
    const wrapped = withRecovery(model, { messages })
    const res = await onTheClock(wrapped.answer({}, {}))
    expect(res.output).toBe('ok')
    expect(callCount).toBe(2)
    expect(messages[2].content).toMatch(/compacted/)
  })

  it('drops turn-groups when compaction is exhausted', async () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: '[compacted — re-read if needed]' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c2', content: '[compacted — re-read if needed]' }
    ]
    let callCount = 0
    const model = {
      info: () => ({ contextTokenLimit: 100 }),
      id: 'test/model',
      answer: async () => {
        callCount++
        if (callCount === 1) throw typedError('CONTEXT_OVERFLOW', { detail: 'context exceeded' })
        return { status: 'completed', output: 'survived' }
      }
    }
    const wrapped = withRecovery(model, { messages })
    const res = await onTheClock(wrapped.answer({}, {}))
    expect(res.output).toBe('survived')
    expect(messages.length).toBe(4) // dropped first turn-group (2 msgs) + 1 context notice
  })

  it('drops multiple turn-groups across retries', async () => {
    const messages = [{ role: 'user', content: 'go' }]
    for (let i = 0; i < 5; i++) {
      messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'read', arguments: {} }] })
      messages.push({ role: 'tool', toolCallId: `c${i}`, content: '[compacted — re-read if needed]' })
    }
    let callCount = 0
    const model = {
      info: () => ({ contextTokenLimit: 100 }),
      id: 'test/model',
      answer: async () => {
        callCount++
        if (callCount <= 3) throw typedError('CONTEXT_OVERFLOW', { detail: 'context exceeded' })
        return { status: 'completed', output: 'ok' }
      }
    }
    const wrapped = withRecovery(model, { messages })
    const res = await onTheClock(wrapped.answer({}, {}))
    expect(res.output).toBe('ok')
    expect(callCount).toBe(4)
    // 3 turn-groups dropped (2 msgs each = 6 removed) + 3 context notices, from 11 → 8
    expect(messages.length).toBe(8)
  })

  it('overflow drops do not consume general retry budget', async () => {
    const messages = [{ role: 'user', content: 'go' }]
    for (let i = 0; i < 3; i++) {
      messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'read', arguments: {} }] })
      messages.push({ role: 'tool', toolCallId: `c${i}`, content: '[compacted — re-read if needed]' })
    }
    let callCount = 0
    const model = {
      info: () => ({ contextTokenLimit: 100 }),
      id: 'test/model',
      answer: async () => {
        callCount++
        // 3 overflow errors, then 1 retryable, then success
        if (callCount <= 3) throw typedError('CONTEXT_OVERFLOW', { detail: 'context exceeded' })
        if (callCount === 4) throw typedError('PROVIDER_OVERLOADED', { retryable: true, detail: 'rate limited' })
        return { status: 'completed', output: 'ok' }
      }
    }
    const wrapped = withRecovery(model, { messages })
    const res = await onTheClock(wrapped.answer({}, {}))
    expect(res.output).toBe('ok')
    expect(callCount).toBe(5)
  })

  it('throws after overflow drop limit', async () => {
    // Build enough messages to exceed MAX_OVERFLOW_DROPS (50)
    const messages = [{ role: 'user', content: 'go' }]
    for (let i = 0; i < 60; i++) {
      messages.push({ role: 'assistant', content: `step ${i}` })
    }
    const model = {
      info: () => ({ contextTokenLimit: 100 }),
      id: 'test/model',
      answer: async () => { throw typedError('CONTEXT_OVERFLOW', { detail: 'context exceeded' }) }
    }
    const wrapped = withRecovery(model, { messages })
    await expect(onTheClock(wrapped.answer({}, {}))).rejects.toThrow(expect.objectContaining({ type: 'CONTEXT_OVERFLOW' }))
    // Should have dropped 50 then stopped. 61 - 50 dropped + 50 context notices = 61
    expect(messages.length).toBe(61)
  })

  it('throws immediately when nothing to drop', async () => {
    const messages = [{ role: 'user', content: 'go' }]
    let callCount = 0
    const model = {
      info: () => ({ contextTokenLimit: 100 }),
      id: 'test/model',
      answer: async () => {
        callCount++
        throw typedError('CONTEXT_OVERFLOW', { detail: 'context exceeded' })
      }
    }
    const wrapped = withRecovery(model, { messages })
    await expect(onTheClock(wrapped.answer({}, {}))).rejects.toThrow(expect.objectContaining({ type: 'CONTEXT_OVERFLOW' }))
    expect(callCount).toBe(1)
    expect(messages.length).toBe(1) // user prompt preserved
  })

  it('typed fatal error throws immediately', async () => {
    const model = mockModel(() => {
      throw typedError('PROVIDER_ERROR', { detail: 'something went wrong' })
    })
    const wrapped = withRecovery(model, { messages: [] })
    await expect(onTheClock(wrapped.answer({}, {}))).rejects.toMatchObject({ type: 'PROVIDER_ERROR' })
    expect(model.callCount).toBe(1)
  })

  it('passes a cancellation on as it came, logging no error', async () => {
    const errors = []
    const logger = { child: () => logger, trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: (obj, msg) => errors.push(msg), fatal: () => {} }
    const model = mockModel(() => {
      throw typedError('OPERATION_CANCELLED', { detail: 'the call was left to finish without it' })
    })
    const wrapped = withRecovery(model, { messages: [], logger })
    await expect(onTheClock(wrapped.answer({}, {}))).rejects.toMatchObject({ type: 'OPERATION_CANCELLED' })
    expect(model.callCount).toBe(1)
    expect(errors).toEqual([])
  })

  it('untyped 400 is fatal', async () => {
    const model = mockModel(() => {
      const err = new Error('Bad Request')
      err.status = 400
      throw err
    })
    const wrapped = withRecovery(model, { messages: [] })
    await expect(onTheClock(wrapped.answer({}, {}))).rejects.toThrow('Bad Request')
    expect(model.callCount).toBe(1)
  })

  it('emits recovery events on drop', async () => {
    const events = []
    const emitter = { emit: (type, data) => events.push({ type, data }) }
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: '[compacted — re-read if needed]' }
    ]
    let callCount = 0
    const model = {
      info: () => ({ contextTokenLimit: 100 }),
      id: 'test/model',
      answer: async () => {
        callCount++
        if (callCount === 1) throw typedError('CONTEXT_OVERFLOW', { detail: 'context exceeded' })
        return { status: 'completed', output: 'ok' }
      }
    }
    const wrapped = withRecovery(model, { messages, emitter })
    await onTheClock(wrapped.answer({}, {}))
    const dropEvent = events.find(e => e.type === 'recovery' && e.data.action === 'drop')
    expect(dropEvent).toBeDefined()
    expect(dropEvent.data.dropped).toBe(2)
  })

  // ── Cancellation ───────────────────────────────────────────────

  it('throws Cancelled when signal is pre-aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const model = mockModel(() => ({ status: 'completed', output: 'ok' }))
    const wrapped = withRecovery(model, { messages: [], signal: controller.signal })
    await expect(onTheClock(wrapped.answer({}, {}))).rejects.toThrow(expect.objectContaining({ type: 'OPERATION_CANCELLED' }))
    expect(model.callCount).toBe(0)
  })

  it('interrupts retry sleep on abort', async () => {
    const controller = new AbortController()
    const model = mockModel(() => {
      const err = new Error('overloaded')
      err.retryable = true
      throw err
    })
    const wrapped = withRecovery(model, { messages: [], signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    const start = Date.now()
    const ended = wrapped.answer({}, {}).then(() => null, (err) => ({ message: err.message, after: Date.now() - start }))
    await vi.runAllTimersAsync()
    const { message, after } = await ended
    expect(message).toBe('Cancelled')
    expect(after).toBeLessThan(1000)
  })

  // ── Session memory integration ──────────────────────────────────

  it('extracts session memory before dropping on overflow', async () => {
    const messages = [
      { role: 'user', content: 'original goal' },
      { role: 'assistant', content: 'I found the bug in auth.js — the token check fails on expired tokens.' },
      { role: 'assistant', content: 'final' }
    ]
    let callCount = 0
    const model = {
      info: () => ({ contextTokenLimit: 100 }),
      answer: async () => {
        callCount++
        if (callCount <= 1) throw typedError('CONTEXT_OVERFLOW')
        return { status: 'completed', output: 'ok' }
      }
    }
    const sm = createSessionMemory()
    const wrapped = withRecovery(model, { messages, sessionMemory: sm })
    await onTheClock(wrapped.answer({}, {}))
    const facts = sm.getFacts()
    expect(facts.length).toBeGreaterThan(0)
    expect(facts.some(f => f.text.includes('auth.js'))).toBe(true)
  })

  it('retries a used-up quota on the same model, and fails after max retries', async () => {
    let calls = 0
    const only = {
      info: () => ({}),
      id: 'last',
      answer: async () => {
        calls++
        const err = new Error('rate limited'); err.type = 'RATE_LIMIT_TIER'; err.retryable = true; err.detail = 'tier'
        throw err
      }
    }
    const wrapped = withRecovery(only, { messages: [] })
    await expect(onTheClock(wrapped.answer({}, {}))).rejects.toMatchObject({ type: 'RATE_LIMIT_TIER' })
    // 1 initial + MAX_RETRIES=3 retries
    expect(calls).toBe(4)
  })

  it('refuses to wrap no model', () => {
    expect(() => withRecovery(undefined, { messages: [] })).toThrow()
  })

  it('works unchanged without sessionMemory', async () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'x' },
      { role: 'assistant', content: 'y' }
    ]
    let callCount = 0
    const model = {
      info: () => ({ contextTokenLimit: 100 }),
      answer: async () => {
        callCount++
        if (callCount <= 1) throw typedError('CONTEXT_OVERFLOW')
        return { status: 'completed', output: 'ok' }
      }
    }
    const wrapped = withRecovery(model, { messages })
    const res = await onTheClock(wrapped.answer({}, {}))
    expect(res.output).toBe('ok')
  })
})

describe('recovery — translated producer shapes', () => {
  const PROVIDER_DETAIL = '400 {"type":"error","error":{"message":"prompt is too long: 204834 tokens > 200000 maximum"}}'

  function overflowMessages () {
    return [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: 'x'.repeat(80000) }
    ]
  }

  function mohdelInProcessError (key) {
    const err = new Error('context length exceeded')
    err.type = key
    err.detail = PROVIDER_DETAIL
    err.retryable = false
    return err
  }

  function gateRoutedError (key) {
    return new SporeError('context length exceeded', {
      type: key, detail: PROVIDER_DETAIL, retryable: false
    })
  }

  it('compacts on overflow from in-process mohdel', async () => {
    const messages = overflowMessages()
    let callCount = 0
    const model = {
      info: () => ({ contextTokenLimit: 5000 }),
      id: 'test/model',
      answer: async () => {
        callCount++
        if (callCount === 1) throw mohdelInProcessError('CONTEXT_OVERFLOW')
        return { status: 'completed', output: 'ok after compact' }
      }
    }
    const wrapped = withRecovery(model, { messages })
    const res = await onTheClock(wrapped.answer({}, {}))
    expect(res.output).toBe('ok after compact')
    expect(messages[2].content).toMatch(/compacted/)
  })

  it('compacts on overflow from gate-routed mohdel', async () => {
    const messages = overflowMessages()
    let callCount = 0
    const model = {
      info: () => ({ contextTokenLimit: 5000 }),
      id: 'test/model',
      answer: async () => {
        callCount++
        if (callCount === 1) throw gateRoutedError('CONTEXT_OVERFLOW')
        return { status: 'completed', output: 'ok after compact' }
      }
    }
    const wrapped = withRecovery(model, { messages })
    const res = await onTheClock(wrapped.answer({}, {}))
    expect(res.output).toBe('ok after compact')
    expect(messages[2].content).toMatch(/compacted/)
  })

  it('translates a real in-process MohdelError and runs the overflow ladder', async () => {
    const messages = overflowMessages()
    let calls = 0
    const model = {
      info: () => ({ contextTokenLimit: 5000 }),
      id: 'anthropic/claude-haiku-4-5',
      answer: async () => {
        calls++
        if (calls === 1) {
          throw MohdelError.fromJSON({
            message: 'context length exceeded',
            type: 'CONTEXT_OVERFLOW',
            detail: PROVIDER_DETAIL,
            severity: 'warn',
            retryable: false
          }, { provider: 'anthropic', model: 'claude-haiku-4-5' })
        }
        return { status: 'completed', output: 'ok after compact' }
      }
    }
    const wrapped = withRecovery(model, { messages })
    const res = await onTheClock(wrapped.answer({}, {}))
    expect(res.output).toBe('ok after compact')
    expect(calls).toBe(2)
    expect(messages[2].content).toMatch(/compacted/)
  })

  it('passes a mohdel in-process error through untranslated', async () => {
    const model = {
      info: () => ({ contextTokenLimit: 100000 }),
      id: 'anthropic/claude-haiku-4-5',
      answer: async () => {
        throw MohdelError.fromJSON(
          { message: 'authentication failed', type: 'AUTH_INVALID', detail: 'bad key', retryable: false },
          { provider: 'anthropic', model: 'claude-haiku-4-5' }
        )
      }
    }
    const wrapped = withRecovery(model, { messages: [] })
    await expect(onTheClock(wrapped.answer({}, {}))).rejects.toMatchObject({
      name: 'MohdelError',
      type: 'AUTH_INVALID',
      message: 'authentication failed',
      detail: 'bad key',
      context: { provider: 'anthropic', model: 'claude-haiku-4-5' }
    })
  })

  it('treats an unrecognized translated key as fatal', async () => {
    let callCount = 0
    const model = {
      info: () => ({ contextTokenLimit: 100000 }),
      id: 'test/model',
      answer: async () => { callCount++; throw gateRoutedError('AUTH_INVALID') }
    }
    const wrapped = withRecovery(model, { messages: [] })
    await expect(onTheClock(wrapped.answer({}, {}))).rejects.toMatchObject({ type: 'AUTH_INVALID' })
    expect(callCount).toBe(1)
  })
})
