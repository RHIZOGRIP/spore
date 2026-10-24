import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeTools } from '../src/tools/make-tools.js'
import { runSpore } from '../src/core/spore-run.js'
import { callRuns, createCallTrail, readCall, readCalls } from '../src/core/call-record.js'
import { hostState, readPending, readTranscript } from '../src/core/spore-dir.js'
import { shownToModel } from './fixtures/as-shown.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.ask-contract-workspace')

const QUESTION = 'The repo has two lockfiles. Which one is authoritative, package-lock.json or the pnpm one?'

let ask

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
  ask = shownToModel(makeTools(WS, 50000, createCallTrail(WS, { runId: 'test', state: hostState(WS) })).fns).ask
})

afterEach(() => {
  rmSync(WS, { recursive: true, force: true })
})

describe('ask as a tool', () => {
  it('answers with the question itself, not a call record', async () => {
    expect(await ask({ question: QUESTION })).toBe(QUESTION)
  })

  it('still leaves a record of having asked', async () => {
    await ask({ question: QUESTION })
    const meta = readCall(WS, 'test', '0001')
    expect(meta.tool).toBe('ask')
    expect(meta.question).toBe(QUESTION)
  })

  it('refuses a question that is missing or empty', async () => {
    expect(await ask({})).toMatch(/^error: question is required/)
    expect(await ask({ question: '   ' })).toMatch(/^error: question is required/)
  })

  it('refuses a parameter it does not take', async () => {
    expect(await ask({ question: QUESTION, out: 'q.txt' })).toMatch(/unexpected parameter "out"/)
  })
})

// One model that asks, then — on the turn after — answers. `use()` is called
// once per run, so the counter distinguishes the two turns.
const asksThenAnswers = (question = QUESTION) => {
  let turn = 0
  return {
    use: () => {
      const asking = turn++ === 0
      return {
        answer: async () => (asking
          ? { status: 'tool_use', toolCalls: [{ id: 'c1', name: 'ask', arguments: { question } }] }
          : { status: 'completed', output: 'using package-lock.json then' })
      }
    }
  }
}

const run = (mo, over = {}) => runSpore({
  prompt: 'fix the build',
  workspace: WS,
  identity: 'You are a spore under test.',
  modelId: 'fake/model',
  limits: { rounds: { soft: 10, hard: 12 } },
  mo,
  state: hostState(WS),
  ...over
})

// The scheduler runs readers together and mutators after them, so a write queued
// behind an ask ran before the question ever reached anyone.
const asksAndWrites = () => ({
  use: () => ({
    answer: async () => ({
      status: 'tool_use',
      toolCalls: [
        { id: 'c1', name: 'ask', arguments: { question: QUESTION } },
        { id: 'c2', name: 'wsexec', arguments: { command: 'echo done', out: 'data/after.txt' } }
      ]
    })
  })
})

describe('ask as an interrupt', () => {
  it('stops the batch, so nothing queued behind it runs', async () => {
    const result = await run(asksAndWrites())
    expect(result.stopReason).toBe('question')
    expect(existsSync(resolve(WS, 'data/after.txt'))).toBe(false)
  })

  it('answers the calls it did not run, so the transcript stays whole', async () => {
    await run(asksAndWrites())
    const transcript = readTranscript(WS)
    const assistant = transcript.find(m => m.role === 'assistant' && m.toolCalls)
    const results = transcript.filter(m => m.role === 'tool')
    expect(results).toHaveLength(assistant.toolCalls.length)
    expect(results.at(-1).content).toMatch(/not run — "ask" ended the turn before it/)
  })

  it('does not end the turn on an ask the tool refused', async () => {
    let round = 0
    const mo = {
      use: () => ({
        answer: async () => (round++ === 0
          ? { status: 'tool_use', toolCalls: [{ id: 'c1', name: 'ask', arguments: {} }] }
          : { status: 'completed', output: 'recovered' })
      })
    }
    const result = await run(mo)
    // An error message is not a question to put to anyone.
    expect(result.stopReason).toBe('answer')
    expect(result.output).toBe('recovered')
  })

  it('ends the turn with the question as the answer', async () => {
    const result = await run(asksThenAnswers())
    expect(result.stopReason).toBe('question')
    expect(result.output).toBe(QUESTION)
    expect(readPending(WS)).toMatchObject({ stopReason: 'question', output: QUESTION })
  })

  it('ends the turn on a question that begins "error:", which is what the model wrote and not a refusal', async () => {
    const question = 'error: the build fails on node 22 — which version should I target?'
    const result = await run(asksThenAnswers(question))
    expect(result).toMatchObject({ stopReason: 'question', output: question })
    const calls = readCalls(WS, callRuns(WS)[0]).map(entry => entry.record)
    expect(calls.map(r => [r.tool, Boolean(r.refused)])).toEqual([['ask', false]])
  })

  it('leaves the question in the transcript exactly once', async () => {
    await run(asksThenAnswers())
    const transcript = readTranscript(WS)
    expect(transcript.filter(m => m.content === QUESTION)).toHaveLength(1)
    expect(transcript.at(-1)).toMatchObject({ role: 'tool', toolName: 'ask', content: QUESTION })
  })

  it('carries the answer into the next turn', async () => {
    const mo = asksThenAnswers()
    await run(mo)
    const result = await run(mo, { prompt: 'package-lock.json', initialMessages: readTranscript(WS) })
    expect(result.stopReason).toBe('answer')

    const transcript = readTranscript(WS)
    const question = transcript.findIndex(m => m.content === QUESTION)
    const reply = transcript.findIndex(m => m.content === 'package-lock.json')
    expect(question).toBeGreaterThan(-1)
    expect(reply).toBe(question + 1)
    expect(transcript.at(-1).content).toBe('using package-lock.json then')
  })
})
