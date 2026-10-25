/**
 * What the loop sends is mohdel's wire `Message`, and nothing else.
 *
 * The gate's types refuse a field they do not define (`mohdel-protocol`, `Message`,
 * `MessagePart`, `ToolCall`), so a note of spore's own left on a message fails the call
 * there. The oracle below is those types, written down; a turn that wraps, drops a
 * turn-group on overflow and replays a compacted head is checked call by call.
 */

import { describe, it, expect } from 'vitest'

import { loopOf } from './fixtures/collaborators.js'
import { compactionSummaryMessage } from '../src/resilience/compaction.js'

const ROLES = new Set(['system', 'user', 'assistant', 'tool'])
const MESSAGE_KEYS = new Set(['role', 'content', 'toolCallId', 'toolName', 'toolCalls'])
const PART_KEYS = {
  text: new Set(['type', 'text', 'cache']),
  reasoning: new Set(['type', 'text']),
  image: new Set(['type', 'fileUri', 'mimeType'])
}
const TOOL_CALL_KEYS = new Set(['id', 'name', 'arguments', 'thoughtSignature'])

function problemsOf (prompt) {
  const problems = []
  prompt.forEach((message, i) => {
    for (const key of Object.keys(message)) if (!MESSAGE_KEYS.has(key)) problems.push(`message ${i} has ${key}`)
    if (!ROLES.has(message.role)) problems.push(`message ${i} has role ${message.role}`)
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        const allowed = PART_KEYS[part.type]
        if (!allowed) problems.push(`message ${i} has a ${part.type} part`)
        else for (const key of Object.keys(part)) if (!allowed.has(key)) problems.push(`message ${i} has ${key} on a ${part.type} part`)
        if (part.cache !== undefined && !['5m', '1h'].includes(part.cache)) problems.push(`message ${i} has cache ${part.cache}`)
      }
    } else if (typeof message.content !== 'string') {
      problems.push(`message ${i} has content that is neither a string nor parts`)
    }
    for (const call of message.toolCalls || []) {
      for (const key of Object.keys(call)) if (!TOOL_CALL_KEYS.has(key)) problems.push(`message ${i} has ${key} on a tool call`)
    }
  })
  return problems
}

const overflow = () => Object.assign(new Error('context length exceeded'), { type: 'CONTEXT_OVERFLOW' })

// A compacted head, then turn-groups whose results are too short to compact — so an
// overflow is answered by dropping one, which adds recovery's notice.
const history = () => {
  const messages = [compactionSummaryMessage('what came before')]
  for (let i = 0; i < 4; i++) {
    messages.push({ role: 'user', content: `do task ${i} and report back in full detail` })
    messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `t${i}`, name: 'read', arguments: { path: `data/${i}.md` } }] })
    messages.push({ role: 'tool', toolCallId: `t${i}`, toolName: 'read', content: 'ok' })
  }
  return messages
}

describe('what the loop sends', () => {
  it('is wire messages only, through a wrap, an overflow drop and a compacted head', async () => {
    const sent = []
    let call = 0
    const model = {
      id: 'test/model',
      info: () => ({ contextTokenLimit: 60 }),
      answer: async (prompt) => {
        sent.push(prompt)
        call++
        if (call === 1) throw overflow()
        if (call === 2) return { status: 'tool_use', output: '', toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'data/a.png' } }] }
        return { status: 'completed', output: 'done', reasoning: 'thought it through' }
      }
    }

    const result = await loopOf({
      model,
      system: [{ text: 'identity', cache: '5m' }, { text: 'memory' }],
      prompt: 'go',
      initialMessages: history(),
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      toolFns: { read: async () => ({ content: 'saw it', images: [{ fileUri: 'file:///ws/data/a.png', mimeType: 'image/png' }] }) },
      limits: { rounds: { soft: 1, hard: 5 } }
    })

    expect(result.output).toBe('done')
    expect(sent).toHaveLength(3)
    for (const prompt of sent) expect(problemsOf(prompt)).toEqual([])

    expect(sent[0][0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'identity', cache: '5m' }, { type: 'text', text: 'memory' }]
    })
    // The retry is sent what recovery changed, not the prompt that overflowed.
    const text = (prompt) => JSON.stringify(prompt)
    expect(text(sent[1])).toMatch(/context was reduced to fit budget/)
    const said = (prompt) => prompt.filter(msg => typeof msg.content === 'string').map(msg => msg.content)
    expect(said(sent[0])).toContain('do task 0 and report back in full detail')
    expect(said(sent[1])).not.toContain('do task 0 and report back in full detail')
    expect(text(sent[1])).toMatch(/What was dropped, in brief:\\n\[Session context from earlier work\]\\n- do task 0/)
    expect(text(sent[2])).toMatch(/\[System: this turn has reached its rounds limit/)
  })
})
