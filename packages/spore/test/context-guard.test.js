import { describe, it, expect } from 'vitest'
import { estimateTokens, compactIfNeeded, dropOldestTurnGroup } from '../src/resilience/context-guard.js'

describe('context guard', () => {
  // ── Token estimation ──────────────────────────────────────────

  it('estimates tokens from message content', () => {
    const messages = [
      { role: 'user', content: 'hello world' } // 11 chars ≈ 3 tokens
    ]
    const tokens = estimateTokens(messages)
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(10)
  })

  it('includes tool call args in estimation', () => {
    const messages = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ name: 'read', arguments: { path: 'very/long/file/path.txt' } }]
      }
    ]
    const tokens = estimateTokens(messages)
    expect(tokens).toBeGreaterThan(5)
  })

  // ── Compaction ────────────────────────────────────────────────

  it('does nothing when under budget', () => {
    const messages = [
      { role: 'user', content: 'short' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: 'small result' }
    ]
    const compacted = compactIfNeeded(messages, { contextLimit: 100000 })
    expect(compacted).toBe(0)
    expect(messages[2].content).toBe('small result')
  })

  it('compacts oldest tool_results when over budget', () => {
    const bigContent = 'x'.repeat(8000) // ~2k tokens
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: bigContent },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c2', content: bigContent },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c3', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c3', content: bigContent },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c4', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c4', content: bigContent },
      // Recent (protected tail)
      { role: 'assistant', content: '', toolCalls: [{ id: 'c5', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c5', content: 'recent' },
      { role: 'assistant', content: 'summary' }
    ]

    const compacted = compactIfNeeded(messages, { contextLimit: 3000, protectTail: 3 })
    expect(compacted).toBeGreaterThan(0)
    // Old results should be compacted
    expect(messages[2].content).toMatch(/compacted/)
    // Recent result should be preserved
    expect(messages[10].content).toBe('recent')
  })

  it('preserves user messages', () => {
    const messages = [
      { role: 'user', content: 'x'.repeat(8000) }, // big user message
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: 'x'.repeat(8000) },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c2', content: 'recent' },
      { role: 'assistant', content: 'done' }
    ]
    compactIfNeeded(messages, { contextLimit: 2000, protectTail: 3 })
    // User message should never be compacted
    expect(messages[0].content.length).toBe(8000)
    // Old tool result should be compacted
    expect(messages[2].content).toMatch(/compacted/)
  })

  it('protects tail messages from compaction', () => {
    const messages = []
    // 20 tool results
    for (let i = 0; i < 20; i++) {
      messages.push({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `c${i}`, name: 'read', arguments: {} }]
      })
      messages.push({
        role: 'tool',
        toolCallId: `c${i}`,
        content: 'x'.repeat(4000)
      })
    }
    // Last 6 messages = last 3 pairs
    compactIfNeeded(messages, { contextLimit: 5000, protectTail: 6 })

    // Last 3 tool_results should be intact
    const tail = messages.slice(-6)
    const tailResults = tail.filter(m => m.role === 'tool')
    for (const r of tailResults) {
      expect(r.content).not.toMatch(/compacted/)
    }

    // Earlier results should be compacted
    expect(messages[1].content).toMatch(/compacted/)
  })

  it('stops compacting once under budget', () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: 'x'.repeat(8000) },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c2', content: 'x'.repeat(8000) },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c3', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c3', content: 'x'.repeat(200) },
      { role: 'assistant', content: 'done' }
    ]

    // Total ~4100 tokens. Budget at 3500 (5000 * 0.7). Compacting c1 (~2000 tokens) should be enough.
    compactIfNeeded(messages, { contextLimit: 5000, protectTail: 2 })

    // First should be compacted
    expect(messages[2].content).toMatch(/compacted/)
    // Third (small) should be intact
    expect(messages[6].content).toBe('x'.repeat(200))
  })

  it('returns 0 when no contextLimit', () => {
    const messages = [
      { role: 'tool', toolCallId: 'c1', content: 'x'.repeat(100000) }
    ]
    expect(compactIfNeeded(messages, {})).toBe(0)
    expect(compactIfNeeded(messages, { contextLimit: 0 })).toBe(0)
  })

  it('uses lastInputTokens when provided', () => {
    // Messages are small (under estimated budget) but lastInputTokens says we're over
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: 'x'.repeat(4000) },
      { role: 'assistant', content: 'done' }
    ]
    // With estimation (~1000 tokens), contextLimit 5000 → budget 3500 → no compaction
    expect(compactIfNeeded(messages, { contextLimit: 5000 })).toBe(0)
    // With lastInputTokens=4000, budget 3500 → compaction triggered
    expect(compactIfNeeded(messages, { contextLimit: 5000, lastInputTokens: 4000, protectTail: 1 })).toBeGreaterThan(0)
  })

  it('falls back to estimation when no lastInputTokens', () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: 'x'.repeat(8000) },
      { role: 'assistant', content: 'done' }
    ]
    // No lastInputTokens → falls back to estimateTokens (~2000) vs budget (5000*0.7=3500) → no compaction
    expect(compactIfNeeded(messages, { contextLimit: 5000 })).toBe(0)
    // With smaller limit → estimate triggers compaction
    expect(compactIfNeeded(messages, { contextLimit: 2000, protectTail: 1 })).toBeGreaterThan(0)
  })

  it('skips compaction when lastInputTokens under budget', () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: 'x'.repeat(8000) },
      { role: 'assistant', content: 'done' }
    ]
    // lastInputTokens=100 is well under budget → no compaction despite large messages
    expect(compactIfNeeded(messages, { contextLimit: 5000, lastInputTokens: 100 })).toBe(0)
  })

  it('logs compaction details', () => {
    const logged = []
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: 'x'.repeat(40000) },
      { role: 'assistant', content: 'done' }
    ]
    compactIfNeeded(messages, {
      contextLimit: 2000,
      protectTail: 1,
      logger: { debug: (...a) => logged.push(a.join(' ')) }
    })
    expect(logged.some(l => l.includes('compacting'))).toBe(true)
    expect(logged.some(l => l.includes('compacted'))).toBe(true)
  })
})

// ── dropOldestTurnGroup ────────────────────────────────────────

describe('dropOldestTurnGroup', () => {
  it('drops assistant + tool_result group', () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: 'file contents' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'write', arguments: {} }] },
      { role: 'tool', toolCallId: 'c2', content: 'ok' }
    ]
    const dropped = dropOldestTurnGroup(messages)
    expect(dropped).toBe(2)
    expect(messages.length).toBe(3)
    expect(messages[1].toolCalls[0].id).toBe('c2')
  })

  it('drops assistant + parallel tool_results', () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }, { id: 'c2', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: 'a' },
      { role: 'tool', toolCallId: 'c2', content: 'b' },
      { role: 'assistant', content: 'done' }
    ]
    const dropped = dropOldestTurnGroup(messages)
    expect(dropped).toBe(3)
    expect(messages.length).toBe(2)
    expect(messages[1].content).toBe('done')
  })

  it('drops standalone assistant', () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'thinking...' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: 'data' }
    ]
    const dropped = dropOldestTurnGroup(messages)
    expect(dropped).toBe(1)
    expect(messages.length).toBe(3)
    expect(messages[1].toolCalls[0].id).toBe('c1')
  })

  it('never drops messages[0]', () => {
    const messages = [{ role: 'user', content: 'go' }]
    const dropped = dropOldestTurnGroup(messages)
    expect(dropped).toBe(0)
    expect(messages.length).toBe(1)
  })

  it('drops user at index > 0', () => {
    const messages = [
      { role: 'user', content: 'original' },
      { role: 'user', content: 'follow-up' },
      { role: 'assistant', content: 'reply' }
    ]
    const dropped = dropOldestTurnGroup(messages)
    expect(dropped).toBe(1)
    expect(messages.length).toBe(2)
    expect(messages[1].content).toBe('reply')
  })

  it('successive calls progressively shrink array', () => {
    const messages = [{ role: 'user', content: 'go' }]
    for (let i = 0; i < 5; i++) {
      messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'read', arguments: {} }] })
      messages.push({ role: 'tool', toolCallId: `c${i}`, content: `result ${i}` })
    }
    expect(messages.length).toBe(11)

    for (let i = 0; i < 5; i++) {
      const dropped = dropOldestTurnGroup(messages)
      expect(dropped).toBe(2)
    }
    expect(messages.length).toBe(1)
    expect(dropOldestTurnGroup(messages)).toBe(0)
  })

  it('handles compacted markers', () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: '[compacted — re-read if needed]' },
      { role: 'assistant', content: 'done' }
    ]
    const dropped = dropOldestTurnGroup(messages)
    expect(dropped).toBe(2)
    expect(messages.length).toBe(2)
    expect(messages[1].content).toBe('done')
  })

  it('calls beforeDrop with messages about to be removed', () => {
    let captured
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'plan', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'file contents here' },
      { role: 'assistant', content: 'done' }
    ]
    dropOldestTurnGroup(messages, { beforeDrop: (msgs) => { captured = msgs } })
    expect(captured).toHaveLength(2)
    expect(captured[0].role).toBe('assistant')
    expect(captured[1].role).toBe('tool')
  })

  it('calls beforeDrop for standalone message', () => {
    let captured
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'standalone answer' },
      { role: 'assistant', content: 'later' }
    ]
    dropOldestTurnGroup(messages, { beforeDrop: (msgs) => { captured = msgs } })
    expect(captured).toHaveLength(1)
    expect(captured[0].content).toBe('standalone answer')
  })

  it('works without beforeDrop (backward compat)', () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'x' }
    ]
    const dropped = dropOldestTurnGroup(messages)
    expect(dropped).toBe(1)
  })
})
