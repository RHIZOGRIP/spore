import { describe, it, expect } from 'vitest'
import { compactHistory } from '../src/resilience/compaction.js'
import { COMPACTED, mark, marked } from '../src/core/marks.js'
import { createSessionMemory } from '../src/resilience/session-memory.js'
import { estimateTokens } from '../src/resilience/context-guard.js'

function mockModel (summaryText) {
  return {
    info: () => ({ contextTokenLimit: 1000 }),
    answer: async () => ({ output: summaryText })
  }
}

function makeMessages (count) {
  const msgs = []
  for (let i = 0; i < count; i++) {
    msgs.push({ role: 'user', content: `Question ${i}: ${'x'.repeat(200)}` })
    msgs.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `c${i}`, name: 'read', arguments: { path: `file${i}.txt` } }]
    })
    msgs.push({
      role: 'tool',
      toolCallId: `c${i}`,
      toolName: 'read',
      content: 'x'.repeat(500)
    })
    msgs.push({ role: 'assistant', content: `Answer ${i}: done` })
  }
  return msgs
}

describe('compaction as a model call like any other', () => {
  const head = () => Array.from({ length: 24 }, (_, n) => ({ role: n % 2 ? 'assistant' : 'user', content: 'x'.repeat(400) }))

  it('obeys the deadline and reports what it cost', async () => {
    let sawSignal = null
    let cost = 0
    const model = {
      info: () => ({ contextTokenLimit: 2000 }),
      answer: async (_input, opts) => {
        sawSignal = opts.signal
        return { output: 'THE SUMMARY', cost: 0.2 }
      }
    }
    const stopping = new AbortController()
    await compactHistory(head(), {
      model,
      contextLimit: 2000,
      signal: stopping.signal,
      onCost: (c) => { cost += c },
      onCompacted: () => {}
    })

    // Without the signal a 30ms hard wall waited for a summary; without the cost it
    // vanished from the record, counted as ours by the broker and by nothing else.
    expect(sawSignal).toBe(stopping.signal)
    expect(cost).toBeCloseTo(0.2)
  })
})

describe('compaction', () => {
  it('returns messages unchanged when under budget', async () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' }
    ]
    const model = mockModel('summary')
    // Large context limit — no compaction needed
    model.info = () => ({ contextTokenLimit: 100000 })
    const result = await compactHistory(messages, { model, contextLimit: 100000 })
    expect(result).toBe(messages)
  })

  it('compacts when over budget', async () => {
    const messages = makeMessages(15) // 60 messages, lots of content
    const model = mockModel('Summary: 15 tasks were completed successfully.')
    const result = await compactHistory(messages, { model, contextLimit: 2000 })

    // Should be shorter than original
    expect(result.length).toBeLessThan(messages.length)
    // First message should be the summary
    expect(marked(result[0], COMPACTED)).toBe(true)
    expect(result[0].content).toContain('Summary')
    // Tail should be intact (real messages, not compacted)
    const tail = result.slice(1)
    expect(tail.some(m => m.role === 'assistant')).toBe(true)
  })

  it('preserves tail turn-groups', async () => {
    const messages = makeMessages(10)
    const model = mockModel('Old work summary.')
    const result = await compactHistory(messages, { model, contextLimit: 1000 })

    // Last few messages should be original (not compacted)
    const lastMsg = result[result.length - 1]
    expect(marked(lastMsg, COMPACTED)).toBe(false)
    expect(lastMsg.role).toBe('assistant')
  })

  // The tail used to be a count of groups derived from `floor(budget / 30_000)`, so a
  // budget bought three groups whether a group weighed 30,000 tokens or 300. On a long
  // conversation that kept 905 tokens of a 100,000-token budget and summarized the rest.
  it('spends what it keeps on the tail instead of guessing what a group weighs', async () => {
    // 200 short exchanges: every message is its own group, none of them large.
    const messages = Array.from({ length: 200 }, (_, n) => ({
      role: n % 2 ? 'assistant' : 'user',
      content: `turn ${n}: ` + 'x'.repeat(400)
    }))
    const contextLimit = 20000 // retention budget is half of it, and half of that is kept
    const result = await compactHistory(messages, { model: mockModel('Older turns.'), contextLimit })

    const tail = result.slice(1)
    const kept = estimateTokens(tail)
    expect(marked(result[0], COMPACTED)).toBe(true)
    // Most of what it keeps, not a rounding error of it.
    expect(kept).toBeGreaterThan(contextLimit * 0.25 * 0.8)
    expect(kept).toBeLessThanOrEqual(contextLimit * 0.25)
    expect(tail.length).toBeGreaterThan(25)
    // And it is the *recent* end that survives.
    expect(tail.at(-1).content).toContain('turn 199')
  })

  it('keeps two groups even when one of them will not fit', async () => {
    const huge = 'x'.repeat(200_000)
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: huge },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: huge }
    ]
    const result = await compactHistory(messages, { model: mockModel('Summary.'), contextLimit: 20000 })
    // A summary and nothing else would leave the turn with no working context at all.
    expect(result.slice(1).length).toBeGreaterThanOrEqual(2)
  })

  it('skips compaction if head is already a summary', async () => {
    const messages = [
      mark({ role: 'user', content: '[Previous conversation summary]\n\nDid stuff.' }, COMPACTED),
      { role: 'user', content: 'New question' },
      { role: 'assistant', content: 'Answer' }
    ]
    const model = mockModel('Should not be called')
    // Small context to trigger compaction check
    const result = await compactHistory(messages, { model, contextLimit: 50 })
    // Should keep as-is since head is already compacted
    expect(result).toEqual(messages)
  })

  it('handles summarization failure gracefully', async () => {
    const messages = makeMessages(10)
    const model = {
      info: () => ({ contextTokenLimit: 1000 }),
      answer: async () => { throw new Error('LLM failed') }
    }
    const result = await compactHistory(messages, { model, contextLimit: 1000 })
    // Should return original messages on failure
    expect(result).toBe(messages)
  })

  it('returns original if too few messages to compact', async () => {
    const messages = [
      { role: 'user', content: 'x'.repeat(5000) },
      { role: 'assistant', content: 'y'.repeat(5000) }
    ]
    const model = mockModel('summary')
    const result = await compactHistory(messages, { model, contextLimit: 500 })
    // Only 2 messages — can't split into head + tail meaningfully
    expect(result).toBe(messages)
  })

  it('summary message has correct shape', async () => {
    const messages = makeMessages(10)
    const model = mockModel('Tasks 1-8 completed. Files converted.')
    const result = await compactHistory(messages, { model, contextLimit: 1000 })

    const summary = result[0]
    expect(summary.role).toBe('user')
    expect(marked(summary, COMPACTED)).toBe(true)
    expect(summary.content).toContain('[Previous conversation summary]')
    expect(summary.content).toContain('Tasks 1-8')
  })

  it('returns original when no model provided', async () => {
    const messages = makeMessages(10)
    const result = await compactHistory(messages, { contextLimit: 1000 })
    expect(result).toBe(messages)
  })

  it('returns original when no contextLimit provided', async () => {
    const messages = makeMessages(10)
    const model = mockModel('summary')
    const result = await compactHistory(messages, { model })
    expect(result).toBe(messages)
  })

  it('extracts session memory from head before summarization', async () => {
    const messages = makeMessages(20)
    const model = mockModel('compact summary')
    const sm = createSessionMemory()
    await compactHistory(messages, { model, contextLimit: 500, sessionMemory: sm })
    const facts = sm.getFacts()
    expect(facts.length).toBeGreaterThan(0)
  })

  it('works unchanged without sessionMemory', async () => {
    const messages = makeMessages(20)
    const model = mockModel('compact summary')
    const result = await compactHistory(messages, { model, contextLimit: 500 })
    expect(marked(result[0], COMPACTED)).toBe(true)
  })
})

describe('the history a definition keeps', () => {
  it('summarizes past the definition\'s budget on a window that would hold it all, and never past half the window', async () => {
    const messages = makeMessages(20)
    const size = estimateTokens(messages)
    const large = 100 * size
    expect(await compactHistory(messages, { model: mockModel('S'), contextLimit: large })).toBe(messages)

    const kept = await compactHistory(messages, { model: mockModel('S'), contextLimit: large, budget: Math.floor(size / 4) })
    expect(kept).not.toBe(messages)
    expect(estimateTokens(kept)).toBeLessThan(size)

    const capped = await compactHistory(messages, { model: mockModel('S'), contextLimit: size, budget: 10 * size })
    expect(capped).not.toBe(messages)
  })
})

describe('the history after a summary', () => {
  const exchange = (n) => [
    { role: 'user', content: `turn ${n}: ` + 'x'.repeat(4000) },
    { role: 'assistant', content: `answer ${n}: ` + 'y'.repeat(4000) }
  ]

  it('keeps 24k word for word past the working set, and grows back for many turns before summarizing again', async () => {
    const messages = Array.from({ length: 150 }, (_, n) => exchange(n)).flat()
    expect(estimateTokens(messages)).toBeGreaterThan(256_000)
    const contextLimit = 1_000_000

    const compacted = await compactHistory(messages, { model: mockModel('Older turns.'), contextLimit })
    expect(marked(compacted[0], COMPACTED)).toBe(true)
    expect(estimateTokens(compacted.slice(1))).toBeLessThanOrEqual(24_000)
    expect(compacted.at(-1).content).toContain('answer 149')

    const grown = [...compacted, ...Array.from({ length: 50 }, (_, n) => exchange(150 + n)).flat()]
    expect(await compactHistory(grown, { model: mockModel('Should not be called'), contextLimit })).toBe(grown)
  })
})
