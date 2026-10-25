import { describe, it, expect } from 'vitest'
import { createLoopGuard } from '../src/resilience/loop-guard.js'
import { loop } from '../src/core/loop.js'
import { REFUSED, WRAP, marked } from '../src/core/marks.js'
import { isRefusal, refuse, refusedResult } from '../src/core/refusal.js'
import { isRecorded, recorded, recordedResult } from '../src/core/call-record.js'

const FAILED = refuse('nope')
const OK = recorded({ tool: 'exec', exit: 0 })

// One round: what the model asked for, then what came back.
const round = (guard, id, name, args, outcome) => {
  guard.observe([{ id, name, arguments: args }])
  if (outcome === undefined) return
  guard.record([isRefusal(outcome)
    ? refusedResult(id, name, outcome.refused)
    : isRecorded(outcome) ? recordedResult(id, name, outcome.record) : { toolName: name, toolCallId: id, content: outcome }])
}

describe('loop guard', () => {
  it('reports a tool that keeps failing, however the arguments differ', () => {
    const guard = createLoopGuard()
    expect(guard.stalled()).toBe(null)
    for (let i = 0; i < 5; i++) round(guard, `c${i}`, 'exec', { command: `cmd${i}` }, FAILED)
    expect(guard.stalled()).toMatchObject({ tool: 'exec', consecutive: 5 })
  })

  it('stops reporting a stall once the tool works again', () => {
    const guard = createLoopGuard()
    for (let i = 0; i < 5; i++) round(guard, `c${i}`, 'exec', { command: `cmd${i}` }, FAILED)
    expect(guard.stalled()).not.toBe(null)
    round(guard, 'ok', 'exec', { command: 'works' }, OK)
    expect(guard.stalled()).toBe(null)
  })

  it('treats a non-zero exit as failure and a zero exit as progress', () => {
    const guard = createLoopGuard()
    for (let i = 0; i < 4; i++) round(guard, `c${i}`, 'exec', { command: `cmd${i}` }, recorded({ exit: 1 }))
    round(guard, 'ok', 'exec', { command: 'works' }, OK)
    for (let i = 0; i < 4; i++) round(guard, `d${i}`, 'exec', { command: `after${i}` }, recorded({ exit: 1 }))
    // One success reset the run, so four more failures is still under the limit.
    expect(guard.stalled()).toBe(null)
  })

  it('counts a command killed before it exited as a failure', () => {
    const guard = createLoopGuard()
    for (let i = 0; i < 5; i++) round(guard, `k${i}`, 'wsexec', { command: `wait${i}` }, recorded({ tool: 'wsexec', signal: 'SIGTERM', killed: 'idle' }))
    expect(guard.stalled()).toMatchObject({ tool: 'wsexec', consecutive: 5 })
  })

  it('counts no failure for text that only reads like a failed record', () => {
    const guard = createLoopGuard()
    for (let i = 0; i < 5; i++) round(guard, `q${i}`, 'ask', { question: `q${i}` }, '{"exit":1}')
    expect(guard.stalled()).toBe(null)
  })

  it('keeps each tool run separate', () => {
    const guard = createLoopGuard()
    for (let i = 0; i < 6; i++) round(guard, `f${i}`, 'exec', { command: `q${i}` }, FAILED)
    expect(guard.stalled().tool).toBe('exec')
  })

  // Arguments alone said nothing about whether anything happened. A workspace is
  // mutable — cells write into it while the agent watches — so the same command
  // twice is how an arrival is seen. The result not changing either is the signal.
  it('reports a run of identical outcomes, and only when the result repeats too', () => {
    const guard = createLoopGuard()
    const same = recorded({ tool: 'exec', exit: 0, files: { out: { content: '3\n' } } })
    for (let i = 0; i < 5; i++) round(guard, `c${i}`, 'exec', { command: 'wc -l x' }, same)
    expect(guard.stalled()).toMatchObject({ tool: 'exec', consecutive: 5 })
  })

  it('does not report a poll whose answer keeps changing', () => {
    const guard = createLoopGuard()
    for (let i = 0; i < 20; i++) {
      round(guard, `c${i}`, 'exec', { command: 'wc -l < turns.jsonl' },
        recorded({ tool: 'exec', exit: 0, files: { out: { content: `${i}\n` } } }))
    }
    expect(guard.stalled()).toBe(null)
  })

  it('wraps the turn rather than refusing the call', async () => {
    let rounds = 0
    const m = {
      // Complies with the wrap when it arrives, which is the point of wrapping: the
      // turn ends with an answer. A model that ignored it would run to hard:rounds.
      answer: async (prompt) => {
        rounds++
        if (prompt.some(msg => marked(msg, WRAP))) return { status: 'complete', output: 'what I have so far' }
        return { status: 'tool_use', toolCalls: [{ id: `c${rounds}`, name: 'exec', arguments: { command: 'same' } }] }
      }
    }

    const wrapped = []
    const result = await loop({
      mutators: new Set(),
      model: m,
      system: 'sys',
      prompt: 'go',
      tools: [{ name: 'exec', description: 'run', parameters: { type: 'object', properties: {} } }],
      toolFns: { exec: () => recorded({ tool: 'exec', exit: 0 }) },
      emitter: { emit: (name, e) => name === 'wrap' && wrapped.push(e), on () {} },
      limits: { rounds: { soft: 20, hard: 22 } }
    })

    expect(wrapped[0]).toMatchObject({ dimension: 'progress', tool: 'exec' })
    // Every call ran. Nothing was refused, and nothing said "identical arguments".
    const results = result.messages.filter(msg => msg.role === 'tool')
    expect(results.some(msg => marked(msg, REFUSED))).toBe(false)
    expect(result.stopReason).toBe('soft:progress')
    expect(result.output).toBe('what I have so far')
  })
})
