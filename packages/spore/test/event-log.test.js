import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { createEmitter } from '../src/observability/emitter.js'
import { attachEventLog, EVENTS, PROMISED, SCHEMA } from '../src/observability/event-log.js'
import { hostState, readEvents } from '../src/core/spore-dir.js'

const WS = resolve(tmpdir(), 'spore-events-test')

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
})
afterEach(() => rmSync(WS, { recursive: true, force: true }))

const logging = ({ runId = 'run-1' } = {}) => {
  const emitter = createEmitter()
  const log = attachEventLog(emitter, { state: hostState(WS), runId })
  return { emitter, close: () => log.flush() }
}

describe('the event log', () => {
  it('writes one event per emit, carrying the version, the run and a sequence', () => {
    const { emitter, close } = logging()
    emitter.emit('round', { index: 0 })
    emitter.emit('tool_start', { name: 'read', callId: 'c1' })
    close()

    const written = readEvents(WS)
    expect(written).toHaveLength(2)
    expect(written[0]).toMatchObject({ v: SCHEMA, seq: 1, runId: 'run-1', event: 'round', index: 0 })
    expect(written[1]).toMatchObject({ seq: 2, event: 'tool_start', name: 'read' })
    expect(written[0].at).toMatch(/^\d{4}-/)
  })

  // A turn that crashed leaves the next one counting from where it stopped, so a consumer
  // never sees a sequence go backwards.
  it('continues the sequence across turns rather than restarting it', () => {
    const first = logging()
    first.emitter.emit('round', { index: 0 })
    first.close()

    const second = logging({ runId: 'run-2' })
    second.emitter.emit('round', { index: 0 })
    second.close()

    expect(readEvents(WS).map(e => e.seq)).toEqual([1, 2])
    expect(readEvents(WS).map(e => e.runId)).toEqual(['run-1', 'run-2'])
  })

  it('answers a consumer resuming from where it left off', () => {
    const { emitter, close } = logging()
    for (let i = 0; i < 4; i++) emitter.emit('round', { index: i })
    close()

    expect(readEvents(WS, { after: 2 }).map(e => e.index)).toEqual([2, 3])
    expect(readEvents(WS, { after: 99 })).toEqual([])
  })

  it('ignores an event it does not carry, so a new one is additive', () => {
    const { emitter, close } = logging()
    emitter.emit('something_later', { x: 1 })
    emitter.emit('round', { index: 0 })
    close()

    expect(readEvents(WS).map(e => e.event)).toEqual(['round'])
  })

  it('carries each model call\'s usage', () => {
    const { emitter, close } = logging()
    emitter.emit('usage', { model: 'p/m', input: 1200, output: 80, cost: 0.002 })
    close()

    expect(readEvents(WS)).toMatchObject([{ event: 'usage', input: 1200, cost: 0.002 }])
  })

  it('does not listen for what nothing produces yet', () => {
    expect(PROMISED).toEqual([])
    expect(EVENTS).toContain('mohdel_idle')
  })

  it('carries a provider\'s silence as mohdel reports it', () => {
    const { emitter, close } = logging()
    emitter.emit('mohdel_idle', { sinceMs: 30000 })
    close()

    expect(readEvents(WS)).toMatchObject([{ event: 'mohdel_idle', sinceMs: 30000 }])
  })

  it('names the supervisor\'s turn_end and an embedder\'s annotation, and never writes either for the agent', () => {
    expect(EVENTS).toContain('turn_end')
    expect(EVENTS).toContain('annotation')
    const { emitter, close } = logging()
    emitter.emit('turn_end', { turnNo: 1 })
    emitter.emit('annotation', { text: 'usually 2 min' })
    emitter.emit('round', { index: 0 })
    close()

    expect(readEvents(WS).map(e => e.event)).toEqual(['round'])
  })

  describe('as a client of the stream', () => {
    it('writes a burst of one kind as one event', () => {
      const { emitter, close } = logging()
      for (const delta of ['hel', 'lo', ' there']) emitter.emit('stream', { kind: 'message', delta })
      close()
      expect(readEvents(WS).map(e => [e.event, e.kind, e.delta])).toEqual([['stream', 'message', 'hello there']])
    })

    it('starts a new event when the kind changes', () => {
      const { emitter, close } = logging()
      emitter.emit('stream', { kind: 'reasoning', delta: 'hmm ' })
      emitter.emit('stream', { kind: 'reasoning', delta: 'ok' })
      emitter.emit('stream', { kind: 'message', delta: 'answer' })
      close()
      expect(readEvents(WS).map(e => [e.kind, e.delta])).toEqual([['reasoning', 'hmm ok'], ['message', 'answer']])
    })

    it('writes what was streamed before anything that came after it', () => {
      const { emitter, close } = logging()
      emitter.emit('stream', { kind: 'message', delta: 'calling a tool' })
      emitter.emit('tool_start', { name: 'read', callId: 'c1' })
      emitter.emit('stream', { kind: 'message', delta: 'done' })
      emitter.emit('complete', { stopReason: 'answer' })
      close()
      expect(readEvents(WS).map(e => e.event)).toEqual(['stream', 'tool_start', 'stream', 'complete'])
    })

    it('does not let one event grow without bound', () => {
      const { emitter, close } = logging()
      for (let i = 0; i < 10; i++) emitter.emit('stream', { kind: 'message', delta: 'x'.repeat(1000) })
      close()
      const written = readEvents(WS)
      expect(written.length).toBeGreaterThan(1)
      expect(written.map(e => e.delta).join('')).toBe('x'.repeat(10000))
    })

    it('leaves what every other listener receives untouched', () => {
      const { emitter, close } = logging()
      const heard = []
      emitter.on('stream', (e) => heard.push(e.delta))
      for (const delta of ['a', 'b', 'c']) emitter.emit('stream', { kind: 'message', delta })
      close()
      expect(heard).toEqual(['a', 'b', 'c'])
    })
  })

  it('carries on when the log cannot be written, because a turn is not worth failing for it', () => {
    const emitter = createEmitter()
    const refusing = { request () { throw new Error('the supervisor closed the channel') } }
    attachEventLog(emitter, { state: refusing, runId: 'r' })
    expect(() => emitter.emit('round', { index: 0 })).not.toThrow()
  })
})
