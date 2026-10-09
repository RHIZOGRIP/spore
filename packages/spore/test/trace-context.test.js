import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeTools } from '../src/tools/make-tools.js'
import { createCallTrail } from '../src/core/call-record.js'
import { hostState, writableDirs } from '../src/core/spore-dir.js'
import { formatTraceparent, parseTraceparent, startSpan } from '../src/observability/tracing.js'
import { shownToModel } from './fixtures/as-shown.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.trace-context-workspace')
const HEADER = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'

const tools = (traceparent) => shownToModel(makeTools(WS, 50000, createCallTrail(WS, { runId: 'test', state: hostState(WS) }), { traceparent }).fns)

const childEnv = async (traceparent) => {
  await tools(traceparent).wsexec({ command: 'env', out: 'data/env.txt' })
  return readFileSync(resolve(WS, 'data/env.txt'), 'utf8').split('\n')
}

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  for (const d of writableDirs(WS)) mkdirSync(d, { recursive: true })
})

afterEach(() => {
  rmSync(WS, { recursive: true, force: true })
})

describe('trace context reaching a subprocess', () => {
  it('hands the running span to everything the agent starts', async () => {
    expect(await childEnv(HEADER)).toContain(`TRACEPARENT=${HEADER}`)
  })

  it('sets nothing at all when there is no trace to pass on', async () => {
    const env = await childEnv(null)
    expect(env.some(line => line.startsWith('TRACEPARENT'))).toBe(false)
  })

  it('passes a header a spawned cell can adopt as its parent', () => {
    const adopted = parseTraceparent(HEADER)
    expect(adopted.spanContext().traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    expect(adopted.spanContext().isRemote).toBe(true)
    // A dispatch span started under it belongs to the same trace, which is the
    // whole point: one fan-out, one trace, not fifty roots.
    expect(startSpan('spore.dispatch', {}, adopted)).toBeDefined()
  })

  // Without ensureOtelInitialized() every span is the API no-op, whose context is
  // all zeroes — so an uninitialised entry point passes nothing on and says so.
  it('formats no header from a span the API never recorded', () => {
    expect(formatTraceparent(startSpan('spore.dispatch', {}))).toBeNull()
  })
})
