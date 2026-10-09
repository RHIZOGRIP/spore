import { describe, it, expect } from 'vitest'
import { sanitizeTranscript } from '../src/resilience/transcript.js'

describe('transcript sanitization', () => {
  // ── Orphaned tool_results ─────────────────────────────────────

  it('drops tool_result with no matching assistant toolCall', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'tool', toolCallId: 'orphan_1', toolName: 'read', content: 'data' }
    ]
    sanitizeTranscript(messages)
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')
  })

  it('keeps valid tool_result paired with assistant toolCall', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'x' } }] },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'data' }
    ]
    sanitizeTranscript(messages)
    expect(messages).toHaveLength(3)
  })

  // ── Duplicate tool_results ────────────────────────────────────

  it('drops duplicate tool_result for same toolCallId', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: 'first' },
      { role: 'tool', toolCallId: 'c1', content: 'duplicate' }
    ]
    sanitizeTranscript(messages)
    const results = messages.filter(m => m.role === 'tool')
    expect(results).toHaveLength(1)
    expect(results[0].content).toBe('first')
  })

  // ── Unpaired toolCalls ────────────────────────────────────────

  it('adds synthetic error result for unpaired toolCall', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] }
      // no tool_result for c1
    ]
    sanitizeTranscript(messages)
    expect(messages).toHaveLength(3)
    const result = messages[2]
    expect(result.role).toBe('tool')
    expect(result.toolCallId).toBe('c1')
    expect(result.content).toMatch(/interrupted/)
  })

  it('adds synthetic results for multiple unpaired toolCalls', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'read', arguments: {} },
          { id: 'c2', name: 'write', arguments: {} }
        ]
      }
    ]
    sanitizeTranscript(messages)
    const results = messages.filter(m => m.role === 'tool')
    expect(results).toHaveLength(2)
    expect(results[0].toolCallId).toBe('c1')
    expect(results[1].toolCallId).toBe('c2')
  })

  it('only adds synthetic result for the missing one when some are present', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'c1', name: 'read', arguments: {} },
          { id: 'c2', name: 'write', arguments: {} }
        ]
      },
      { role: 'tool', toolCallId: 'c1', content: 'ok' }
      // c2 missing
    ]
    sanitizeTranscript(messages)
    const results = messages.filter(m => m.role === 'tool')
    expect(results).toHaveLength(2)
    expect(results[0].content).toBe('ok')
    expect(results[1].toolCallId).toBe('c2')
    expect(results[1].content).toMatch(/interrupted/)
  })

  // ── Truncation ────────────────────────────────────────────────

  it('truncates oversized tool_result content', () => {
    const bigContent = 'x'.repeat(60000)
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: bigContent }
    ]
    sanitizeTranscript(messages, { maxResultSize: 1000 })
    const result = messages.find(m => m.role === 'tool')
    expect(result.content.length).toBeLessThan(1100)
    expect(result.content).toMatch(/truncated/)
  })

  it('respects custom maxResultSize', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: 'x'.repeat(500) }
    ]
    sanitizeTranscript(messages, { maxResultSize: 200 })
    const result = messages.find(m => m.role === 'tool')
    expect(result.content.length).toBeLessThan(300)
  })

  it('does not truncate content under limit', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: 'short' }
    ]
    sanitizeTranscript(messages)
    expect(messages.find(m => m.role === 'tool').content).toBe('short')
  })

  // ── Content normalization ─────────────────────────────────────

  it('normalizes null tool_result content to empty string', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: null }
    ]
    sanitizeTranscript(messages)
    expect(messages.find(m => m.role === 'tool').content).toBe('')
  })

  it('normalizes null assistant content to empty string', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null }
    ]
    sanitizeTranscript(messages)
    expect(messages[1].content).toBe('')
  })

  // ── Complex scenarios ─────────────────────────────────────────

  it('handles multi-turn conversation with mixed issues', () => {
    const messages = [
      { role: 'user', content: 'go' },
      // Turn 1: complete
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: 'ok' },
      // Turn 2: orphaned result
      { role: 'tool', toolCallId: 'ghost', content: 'orphan' },
      // Turn 3: unpaired call (simulates crash mid-execution)
      { role: 'assistant', content: '', toolCalls: [{ id: 'c2', name: 'write', arguments: {} }] },
      // no result for c2
      // Turn 4: normal response
      { role: 'assistant', content: 'done' }
    ]
    sanitizeTranscript(messages)

    // Orphan removed, synthetic result for c2 added
    expect(messages.filter(m => m.toolCallId === 'ghost')).toHaveLength(0)
    const c2Result = messages.find(m => m.toolCallId === 'c2')
    expect(c2Result).toBeTruthy()
    expect(c2Result.content).toMatch(/interrupted/)
  })

  it('is idempotent — running twice produces same result', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', content: 'data' }
    ]
    sanitizeTranscript(messages)
    const snapshot = JSON.stringify(messages)
    sanitizeTranscript(messages)
    expect(JSON.stringify(messages)).toBe(snapshot)
  })

  // ── Logging ───────────────────────────────────────────────────

  it('logs repairs when logger is provided', () => {
    const logged = []
    const logger = { debug: (...a) => logged.push(a.join(' ')) }
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'tool', toolCallId: 'orphan', content: 'x' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] }
    ]
    sanitizeTranscript(messages, { logger })
    expect(logged.some(l => l.includes('orphan'))).toBe(true)
    expect(logged.some(l => l.includes('unpaired') || l.includes('synthetic'))).toBe(true)
  })
})
