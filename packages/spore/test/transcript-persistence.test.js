import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runSpore } from '../src/core/spore-run.js'
import { TOOL_NAMES } from '../src/core/tool-names.js'
import { hostState, readTranscript, readTranscriptEntries, readTurns, writeTranscriptEntries } from '../src/core/spore-dir.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.transcript-workspace')

const answering = (text) => ({ use: () => ({ info: () => null, answer: async () => ({ status: 'completed', output: text }) }) })

// The agent leaves its record for its supervisor to finalize; here the test is the supervisor.
const run = async (over = {}) => {
  const state = hostState(WS)
  try {
    return await runSpore({
      tools: TOOL_NAMES,
      sandbox: false,
      cacheTtl: '5m',
      initialMessages: [],
      prompt: 'what next',
      workspace: WS,
      identity: 'You are a spore under test.',
      modelId: 'fake/model',
      limits: { rounds: { soft: 10, hard: 12 }, cost: { soft: 100, hard: 100 }, wall: { soft: 600_000, hard: 600_000 } },
      mo: answering('done'),
      state,
      ...over
    })
  } finally {
    state.finalize()
  }
}

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
})

afterEach(() => {
  rmSync(WS, { recursive: true, force: true })
})

// A model small enough that a modest history is already over its retention
// budget, so compaction has something to do.
const smallContext = (text) => ({
  use: () => ({
    answer: async () => ({ status: 'completed', output: text }),
    info: () => ({ contextTokenLimit: 2000 })
  })
})

const said = (message) => ({ at: new Date().toISOString(), kind: 'message', role: message.role, message })

const longHistory = (turns) => {
  const messages = []
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user', content: `question ${i} ` + 'x'.repeat(400) })
    messages.push({ role: 'assistant', content: `answer ${i} ` + 'y'.repeat(400) })
  }
  return messages
}

// Cost alone cannot say why a turn was dear: a prefix that missed the cache and one that
// hit it differ by an order of magnitude and are identical in dollars. `cacheRead` on a
// resumed turn is the measurement that says caching works, and it used to live only
// inside the process.
describe('what a turn record says it spent', () => {
  it('records the tokens behind the cost, cache reads included', async () => {
    const counting = {
      use: () => ({
        info: () => null,
        answer: async () => ({
          status: 'completed',
          output: 'done',
          cost: 0.01,
          inputTokens: 1200,
          outputTokens: 40,
          cacheReadInputTokens: 9000,
          cacheWriteInputTokens: 300
        })
      })
    }
    await run({ mo: counting })
    const [turn] = readTurns(WS)
    expect(turn.cacheReadTokens).toBe(9000)
    expect(turn.cacheWriteTokens).toBe(300)
    expect(turn.inputTokens).toBe(1200)
    expect(turn.outputTokens).toBe(40)
  })
})

describe('compaction at the entry point', () => {
  it('summarizes a history that has outgrown its budget, and records the entry', async () => {
    const history = longHistory(12)
    writeTranscriptEntries(WS, history.map(said))

    await run({ initialMessages: readTranscript(WS), mo: smallContext('THE SUMMARY') })

    const raw = readTranscriptEntries(WS)
    const entry = raw.find(e => e.kind === 'compaction')
    expect(entry).toBeDefined()
    expect(entry.message.summary).toBe('THE SUMMARY')
  })

  it('collapses that head on the next read rather than replaying it', async () => {
    const history = longHistory(12)
    writeTranscriptEntries(WS, history.map(said))
    await run({ initialMessages: readTranscript(WS), mo: smallContext('THE SUMMARY') })

    const replayed = readTranscript(WS)
    expect(replayed.length).toBeLessThan(history.length)
    expect(replayed[0].content).toContain('THE SUMMARY')
  })

  it('leaves a short history alone', async () => {
    const history = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]
    writeTranscriptEntries(WS, history.map(said))

    await run({ initialMessages: readTranscript(WS), mo: smallContext('unused') })

    const raw = readTranscriptEntries(WS)
    expect(raw.some(e => e.kind === 'compaction')).toBe(false)
  })
})

describe('transcript persistence', () => {
  it('writes the run to the transcript', async () => {
    await run()
    const lines = readTranscript(WS)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines[0]).toMatchObject({ role: 'user' })
  })

  it('does not re-append messages it was handed to replay', async () => {
    const history = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'earlier answer' }
    ]
    writeTranscriptEntries(WS, history.map(said))

    await run({ initialMessages: readTranscript(WS) })

    const after = readTranscript(WS)
    expect(after.slice(0, 2)).toEqual(history)
    expect(after.filter(m => m.content === 'first')).toHaveLength(1)
    expect(after.filter(m => m.content === 'earlier answer')).toHaveLength(1)
  })

  it('stays linear across repeated resumes rather than doubling', async () => {
    await run()
    const first = readTranscript(WS).length

    await run({ initialMessages: readTranscript(WS) })
    const second = readTranscript(WS).length

    await run({ initialMessages: readTranscript(WS) })
    const third = readTranscript(WS).length

    expect(second - first).toBe(first)
    expect(third - second).toBe(first)
  })

  it('keeps the terminal answer, which loop.js leaves out of messages', async () => {
    await run({ mo: answering('the final word') })
    const after = readTranscript(WS)
    expect(after.at(-1)).toEqual({ role: 'assistant', content: 'the final word' })
  })

  it('replays an answer it persisted, so a resumed turn sees the reply', async () => {
    await run({ mo: answering('first reply') })
    await run({ initialMessages: readTranscript(WS), mo: answering('second reply') })
    const replies = readTranscript(WS).filter(m => m.role === 'assistant').map(m => m.content)
    expect(replies).toEqual(['first reply', 'second reply'])
  })

  it('creates the workspace directories it needs', async () => {
    expect(existsSync(resolve(WS, 'data'))).toBe(false)
    await run()
    expect(existsSync(resolve(WS, 'data'))).toBe(true)
    expect(readTranscript(WS).length).toBeGreaterThan(0)
  })
})

describe('the turn record', () => {
  it('writes one record per turn saying how it ended', async () => {
    await run()
    const [turn] = readTurns(WS)
    expect(turn.stopReason).toBe('answer')
    expect(turn.concluded).toBe(true)
    expect(turn.output).toBe('done')
    expect(turn.rounds).toBe(1)
    expect(turn.runId).toMatch(/^[0-9a-z]+$/)
    expect(Date.parse(turn.endedAt)).toBeGreaterThanOrEqual(Date.parse(turn.startedAt))
  })

  it('appends rather than replacing, so a workspace keeps its history', async () => {
    await run()
    await run({ initialMessages: readTranscript(WS) })
    expect(readTurns(WS)).toHaveLength(2)
  })

  it('records what the turn cost the tree beside what the loop itself cost', async () => {
    await run()
    const [turn] = readTurns(WS)
    // Nothing was spawned here, so the two agree — the point is that both are said.
    expect(turn.treeMicros).toBe(turn.ownMicros)
  })

  // A model that honours the signal rejects. That rejection escaped the loop and
  // runSpore alike, so the record — written after the loop returns — was never
  // reached: no stop reason, no cost, a workspace that looked like it never ran.
  it('records a turn whose model call was cancelled', async () => {
    const stopping = new AbortController()
    const abortAware = {
      use: () => ({
        info: () => null,
        answer: (input, opts) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ status: 'completed', output: 'late' }), 5000)
          opts.signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            const err = new Error('cancelled')
            err.type = 'OPERATION_CANCELLED'
            reject(err)
          })
        })
      })
    }
    setTimeout(() => stopping.abort(), 40)
    const result = await run({ mo: abortAware, signal: stopping.signal })

    expect(result.stopReason).toBe('cancelled')
    const [turn] = readTurns(WS)
    expect(turn).toMatchObject({ stopReason: 'cancelled', concluded: false })
  })

  it('records a turn that produced no answer as one that did not', async () => {
    // A hard round limit stops the turn before the model is ever asked.
    await run({ limits: { rounds: { soft: 0, hard: 0 }, cost: { soft: 100, hard: 100 }, wall: { soft: 600_000, hard: 600_000 } } })
    const [turn] = readTurns(WS)
    expect(turn.stopReason).toBe('hard:rounds')
    expect(turn.concluded).toBe(false)
    expect(turn.output).toBe(null)
  })
})

// `runSpore` is the confined half of a pair. It holds no key, hosts nothing, and
// reaches a model only through what it was handed — so being handed nothing is a
// caller mistake, not a case to paper over by building a client with the environment's
// credentials in it.
describe('what the worker will not build for itself', () => {
  it('refuses to run without a model client, before the turn says how it ended', async () => {
    const state = hostState(WS)
    await expect(runSpore({
      tools: TOOL_NAMES,
      sandbox: false,
      cacheTtl: '5m',
      initialMessages: [],
      prompt: 'what next',
      workspace: WS,
      identity: 'You are a spore under test.',
      modelId: 'fake/model',
      limits: { rounds: { soft: 10, hard: 12 }, cost: { soft: 100, hard: 100 }, wall: { soft: 600_000, hard: 600_000 } },
      state
    })).rejects.toMatchObject({ type: 'MODEL_CLIENT_REQUIRED' })
    expect(() => state.finalize()).toThrow(/has not said how it ended/)
  })
})

// A turn that did billable work and then hit a fatal provider error was recording
// cost 0: the exception path counted only setup cost, because the loop throws without
// returning its usage. The ledger is shared with the broker and already knows what was
// served, so the money is there to be recorded — and benchmark reporting and every
// spend total believed the zero.
describe('what a failed turn remembers', () => {
  it('keeps the spend it had already incurred', async () => {
    let call = 0
    const mo = {
      use: () => ({
        info: () => ({ contextTokenLimit: 200000 }),
        answer: async () => {
          // A billable round that really writes a file, then a fatal provider error.
          if (++call === 1) {
            // `cost` sits at the top of a model response; `loop()` sums it and assigns
            // `ledger.own` each round, which is what makes it readable after a throw.
            return {
              status: 'tool_use',
              cost: 0.125,
              toolCalls: [{ id: 'c1', name: 'write', arguments: { content: 'work', path: 'data/done.txt' } }]
            }
          }
          const err = new Error('provider said no')
          err.type = 'MODEL_REFUSED'
          throw err
        }
      })
    }
    const ledger = { own: 0, children: 0 }

    await expect(run({ mo, ledger, prompt: 'go', limits: { rounds: { soft: 4, hard: 6 }, cost: { soft: 100, hard: 100 }, wall: { soft: 600_000, hard: 600_000 } } })).rejects.toThrow()

    const turn = readTurns(WS).at(-1)
    expect(turn.stopReason).toBe('error')
    expect(turn.error).toBe('MODEL_REFUSED')
    // The money is remembered, not rounded to nothing.
    expect(turn.ownUsd).toBeCloseTo(0.125, 4)
    expect(turn.treeUsd).toBeCloseTo(0.125, 4)
  })
})

describe('what goes ahead of the conversation', () => {
  afterEach(() => vi.useRealTimers())

  // A provider caches a prefix matched byte for byte, and the conversation comes after the
  // system prompt: anything in it that changes makes the whole conversation uncacheable.
  it('is byte for byte the same on every turn, and the time is in the turn\'s own message', async () => {
    const sent = []
    const recording = { use: () => ({ info: () => null, answer: async (messages) => { sent.push(structuredClone(messages)); return { status: 'completed', output: 'done' } } }) }
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-02T09:15:00Z'))
    await run({ mo: recording, dated: true })
    vi.setSystemTime(new Date('2026-10-03T17:42:00Z'))
    await run({ mo: recording, dated: true, prompt: 'and now' })

    const systemOf = (messages) => JSON.stringify(messages.find(m => m.role === 'system'))
    expect(systemOf(sent[1])).toBe(systemOf(sent[0]))
    expect(systemOf(sent[0])).not.toMatch(/2026|Now:/)
    expect(JSON.stringify(sent[0].at(-1))).toMatch(/Now: 2026-10-02T09:15Z \(Friday\)/)
    expect(JSON.stringify(sent[1].at(-1))).toMatch(/Now: 2026-10-03T17:42Z \(Saturday\)/)
    expect(readTranscript(WS).filter(m => m.role === 'user').map(m => m.content)).toEqual(['what next', 'and now'])
  })
})
