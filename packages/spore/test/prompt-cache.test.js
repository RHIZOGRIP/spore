import { describe, expect, test } from 'vitest'

import { markConversationForCaching } from '../src/core/prompt-cache.js'

function wire (messages) {
  return messages.map(m => ({ ...m }))
}

describe('markConversationForCaching', () => {
  test('tags the last text part of the last conversation message', () => {
    const messages = wire([
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'turn 2' }] }
    ])
    markConversationForCaching(messages, '5m')
    expect(messages[2].content).toEqual([{ type: 'text', text: 'turn 2', cache: '5m' }])
    expect(messages[0].content).toBe('turn 1')
    expect(messages[1].content[0].cache).toBeUndefined()
  })

  test('converts a string-content final message to a tagged part array', () => {
    const messages = wire([
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'turn 2' }
    ])
    markConversationForCaching(messages, '1h')
    expect(messages[2].content).toEqual([{ type: 'text', text: 'turn 2', cache: '1h' }])
  })

  test('skips single-message conversations', () => {
    const messages = wire([
      { role: 'user', content: 'only turn' }
    ])
    markConversationForCaching(messages, '5m')
    expect(messages[0].content).toBe('only turn')
  })

  test('does not mutate a shared content array', () => {
    const shared = [{ type: 'text', text: 'turn 2' }]
    const messages = [
      { role: 'user', content: 'turn 1' },
      { role: 'user', content: shared }
    ]
    markConversationForCaching(messages, '5m')
    expect(shared[0].cache).toBeUndefined()
    expect(messages[1].content[0].cache).toBe('5m')
  })

  test('tags the last text part when trailing parts are not text', () => {
    const messages = [
      { role: 'user', content: 'turn 1' },
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'r' }] }
    ]
    markConversationForCaching(messages, '5m')
    expect(messages[1].content[0].cache).toBe('5m')
    expect(messages[1].content[1].cache).toBeUndefined()
  })
})
