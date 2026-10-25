import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trace } from '@opentelemetry/api'

import { runSpore } from '../src/core/spore-run.js'
import { TOOL_NAMES } from '../src/core/tool-names.js'
import { hostState } from '../src/core/spore-dir.js'
import { jsonLogger } from '../src/observability/logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.turn-log-workspace')

// A recording span holds its processor, and the processor holds it back: the SDK's own
// spans cannot be stringified, and this one cannot either.
const recordingSpan = () => {
  const span = {
    spanContext: () => ({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7', traceFlags: 1 }),
    setAttribute: () => span,
    setAttributes: () => span,
    addEvent: () => span,
    setStatus: () => span,
    recordException: () => {},
    updateName: () => span,
    isRecording: () => true,
    end: () => {}
  }
  span.processor = { span }
  return span
}

const answering = { use: () => ({ info: () => null, answer: async () => ({ status: 'completed', output: 'done' }) }) }

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
  trace.setGlobalTracerProvider({ getTracer: () => ({ startSpan: recordingSpan, startActiveSpan: (name, fn) => fn(recordingSpan()) }) })
})

afterEach(() => {
  rmSync(WS, { recursive: true, force: true })
  vi.restoreAllMocks()
})

afterAll(() => trace.disable())

describe('a turn traced by a recording span', () => {
  it('still writes its log, each line naming the trace and the span it is in', async () => {
    const written = []
    vi.spyOn(process.stderr, 'write').mockImplementation((line) => { written.push(String(line)); return true })
    const state = hostState(WS)
    try {
      await runSpore({
        tools: TOOL_NAMES,
        sandbox: false,
        cacheTtl: '5m',
        initialMessages: [],
        prompt: 'what next',
        workspace: WS,
        identity: 'You are a spore under test.',
        modelId: 'fake/model',
        limits: { rounds: { soft: 10, hard: 12 }, cost: { soft: 100, hard: 100 }, wall: { soft: 600_000, hard: 600_000 } },
        mo: answering,
        state,
        logger: jsonLogger({ level: 'info' })
      })
    } finally {
      state.finalize()
    }
    const lines = written.filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    const started = lines.find(line => line.msg === '[spore] loop started')
    expect(started).toMatchObject({ model: 'fake/model', span: { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7' } })
  })
})
