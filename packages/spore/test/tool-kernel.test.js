import { describe, it, expect } from 'vitest'
import { executeTools } from '../src/core/tool-kernel.js'
import { createEmitter } from '../src/observability/emitter.js'
import { REFUSED, marked } from '../src/core/marks.js'

/* ── Helpers ────────────────────────────────────────────────────── */

function tc (id, name, args = {}) {
  return { id, name, arguments: args }
}

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const silent = { trace () {}, debug () {}, info () {}, warn () {}, error () {}, fatal () {} }

/* ── Scheduling ─────────────────────────────────────────────────── */

describe('tool-kernel scheduling', () => {
  it('runs all tools in parallel when no mutators set', async () => {
    const order = []
    const toolFns = {
      a: async () => { order.push('a-start'); await delay(20); order.push('a-end'); return 'a' },
      b: async () => { order.push('b-start'); await delay(20); order.push('b-end'); return 'b' }
    }
    const results = await executeTools({
      toolCalls: [tc('1', 'a'), tc('2', 'b')],
      toolFns,
      logger: silent
    })
    expect(results).toHaveLength(2)
    expect(results[0].content).toBe('a')
    expect(results[1].content).toBe('b')
    // Both started before either ended
    expect(order[0]).toBe('a-start')
    expect(order[1]).toBe('b-start')
  })

  it('runs readers in parallel and writers serially', async () => {
    const order = []
    const toolFns = {
      read1: async () => { order.push('r1-start'); await delay(20); order.push('r1-end'); return 'r1' },
      read2: async () => { order.push('r2-start'); await delay(20); order.push('r2-end'); return 'r2' },
      write1: async () => { order.push('w1-start'); await delay(10); order.push('w1-end'); return 'w1' },
      write2: async () => { order.push('w2-start'); await delay(10); order.push('w2-end'); return 'w2' }
    }
    const mutators = new Set(['write1', 'write2'])
    const results = await executeTools({
      toolCalls: [tc('1', 'read1'), tc('2', 'write1'), tc('3', 'read2'), tc('4', 'write2')],
      toolFns,
      mutators,
      logger: silent
    })
    // Results in original order
    expect(results.map(r => r.content)).toEqual(['r1', 'w1', 'r2', 'w2'])

    // Readers started concurrently (both before either ended)
    const r2s = order.indexOf('r2-start')
    const r1e = order.indexOf('r1-end')
    expect(r2s).toBeLessThan(r1e) // r2 started before r1 ended

    // Writers ran sequentially (w1 ended before w2 started)
    const w1e = order.indexOf('w1-end')
    const w2s = order.indexOf('w2-start')
    expect(w1e).toBeLessThan(w2s)
  })

  it('returns results in original toolCalls order', async () => {
    const toolFns = {
      fast: async () => 'fast',
      slow: async () => { await delay(30); return 'slow' }
    }
    const mutators = new Set(['slow'])
    const results = await executeTools({
      toolCalls: [tc('1', 'slow'), tc('2', 'fast')],
      toolFns,
      mutators,
      logger: silent
    })
    expect(results[0].content).toBe('slow')
    expect(results[1].content).toBe('fast')
    expect(results[0].toolCallId).toBe('1')
    expect(results[1].toolCallId).toBe('2')
  })

  it('returns empty array for empty toolCalls', async () => {
    const results = await executeTools({
      toolCalls: [],
      toolFns: {},
      logger: silent
    })
    expect(results).toEqual([])
  })

  it('all writers serial even when no readers', async () => {
    const order = []
    const toolFns = {
      w1: async () => { order.push('w1-start'); await delay(15); order.push('w1-end'); return 'w1' },
      w2: async () => { order.push('w2-start'); await delay(15); order.push('w2-end'); return 'w2' }
    }
    await executeTools({
      toolCalls: [tc('1', 'w1'), tc('2', 'w2')],
      toolFns,
      mutators: new Set(['w1', 'w2']),
      logger: silent
    })
    expect(order).toEqual(['w1-start', 'w1-end', 'w2-start', 'w2-end'])
  })
})

/* ── Approval ───────────────────────────────────────────────────── */
/* ── Abort ──────────────────────────────────────────────────────── */

describe('tool-kernel abort', () => {
  it('passes child signal to tool function', async () => {
    let receivedSignal
    const toolFns = {
      check: async (args, { signal }) => { receivedSignal = signal; return 'ok' }
    }
    await executeTools({
      toolCalls: [tc('1', 'check')],
      toolFns,
      logger: silent
    })
    expect(receivedSignal).toBeDefined()
    expect(receivedSignal.aborted).toBe(false)
  })

  it('child signal fires when parent aborts', async () => {
    const controller = new AbortController()
    let childAborted = false
    const toolFns = {
      slow: async (args, { signal }) => {
        signal.addEventListener('abort', () => { childAborted = true })
        await delay(50)
        return 'done'
      }
    }
    setTimeout(() => controller.abort(), 10)
    await executeTools({
      toolCalls: [tc('1', 'slow')],
      toolFns,
      signal: controller.signal,
      logger: silent
    })
    expect(childAborted).toBe(true)
  })

  it('does not start a tool once the turn is stopped, and answers its call', async () => {
    const controller = new AbortController()
    const emitter = createEmitter()
    const blocked = []
    emitter.on('tool_block', (e) => blocked.push(e))
    const ran = []
    const toolFns = {
      slow: async (args, { signal }) => {
        ran.push('slow')
        controller.abort()
        return 'stopped'
      },
      write: async () => { ran.push('write'); return 'written' }
    }
    const results = await executeTools({
      toolCalls: [tc('1', 'slow'), tc('2', 'write')],
      toolFns,
      mutators: new Set(['slow', 'write']),
      emitter,
      signal: controller.signal,
      logger: silent
    })
    expect(ran).toEqual(['slow'])
    expect(marked(results[1], REFUSED)).toBe(true)
    expect(results[1].content).toMatch(/^error: not run/)
    expect(blocked).toEqual([{ name: 'write', reason: 'cancelled' }])
  })

  it('tool error does not abort sibling tools', async () => {
    const toolFns = {
      good: async () => { await delay(20); return 'ok' },
      bad: async () => { throw new Error('boom') }
    }
    const results = await executeTools({
      toolCalls: [tc('1', 'good'), tc('2', 'bad')],
      toolFns,
      logger: silent
    })
    expect(results[0].content).toBe('ok')
    expect(results[1].content).toBe('error: boom')
  })
})

/* ── Events & result shape ──────────────────────────────────────── */

describe('tool-kernel events', () => {
  it('emits tool_start and tool_end with callId and timing', async () => {
    const emitter = createEmitter()
    const events = []
    emitter.on('tool_start', (e) => events.push({ type: 'start', ...e }))
    emitter.on('tool_end', (e) => events.push({ type: 'end', ...e }))

    const toolFns = { echo: async ({ text }) => text }
    await executeTools({
      toolCalls: [tc('c1', 'echo', { text: 'hi' })],
      toolFns,
      emitter,
      logger: silent
    })

    expect(events).toHaveLength(2)
    expect(events[0].type).toBe('start')
    expect(events[0].callId).toBe('c1')
    expect(events[0].name).toBe('echo')
    expect(events[1].type).toBe('end')
    expect(events[1].callId).toBe('c1')
    expect(events[1].durationMs).toBeGreaterThanOrEqual(0)
    expect(events[1].error).toBe(false)
  })

  it('tool_end has error: true when tool throws', async () => {
    const emitter = createEmitter()
    let endEvent
    emitter.on('tool_end', (e) => { endEvent = e })

    const toolFns = { fail: async () => { throw new Error('boom') } }
    const results = await executeTools({
      toolCalls: [tc('c1', 'fail')],
      toolFns,
      emitter,
      logger: silent
    })
    expect(endEvent.error).toBe(true)
    expect(results[0].content).toBe('error: boom')
  })

  it('result objects have correct shape', async () => {
    const toolFns = { echo: async ({ text }) => text }
    const results = await executeTools({
      toolCalls: [tc('c1', 'echo', { text: 'hi' })],
      toolFns,
      logger: silent
    })
    const r = results[0]
    expect(r.role).toBe('tool')
    expect(r.toolCallId).toBe('c1')
    expect(r.toolName).toBe('echo')
    expect(r.content).toBe('hi')
  })
})

// Models name tools they do not have. That used to reach `await fn(...)` on undefined
// and answer `fn is not a function` — an error about our internals, saying nothing the
// model could act on. Measured on a cell whose precursor granted read, write and wsexec:
// it called `exec` five times, got that message five times, hit soft:progress and spent
// its whole budget without ever learning the tool was not there.
describe('a tool that is not there', () => {
  it('says so, and says what is', async () => {
    const [result] = await executeTools({
      toolCalls: [{ id: 'a', name: 'exec', arguments: { command: 'ls' } }],
      toolFns: { read: async () => 'ok', write: async () => 'ok' }
    })
    expect(result.content).toBe('error: there is no tool called "exec" here — you have read, write')
    expect(result.toolName).toBe('exec')
    expect(result.toolCallId).toBe('a')
  })

  it('counts as an error in the event, not as a success', async () => {
    const ended = []
    await executeTools({
      toolCalls: [{ id: 'a', name: 'nope', arguments: {} }],
      toolFns: { read: async () => 'ok' },
      emitter: { emit: (name, event) => name === 'tool_end' && ended.push(event), on () {} }
    })
    expect(ended).toHaveLength(1)
    expect(ended[0].error).toBe(true)
  })

  it('does not stop the calls beside it', async () => {
    const results = await executeTools({
      toolCalls: [
        { id: 'a', name: 'nope', arguments: {} },
        { id: 'b', name: 'read', arguments: {} }
      ],
      toolFns: { read: async () => 'content' }
    })
    expect(results.map(r => r.content)).toEqual([
      'error: there is no tool called "nope" here — you have read',
      'content'
    ])
  })
})
