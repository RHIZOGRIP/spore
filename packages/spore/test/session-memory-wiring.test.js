import { describe, it, expect } from 'vitest'

import { withRecovery } from '../src/resilience/recovery.js'
import { createSessionMemory } from '../src/resilience/session-memory.js'
import { CONTEXT_NOTICE, marked } from '../src/core/marks.js'
import { recordedResult } from '../src/core/call-record.js'

const overflow = () => Object.assign(new Error('context length exceeded'), { type: 'CONTEXT_OVERFLOW' })

// A long enough history that dropping one turn-group leaves something behind.
const history = () => {
  const messages = []
  for (let i = 0; i < 6; i++) {
    messages.push({ role: 'user', content: `do task ${i} thoroughly and report back` })
    messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `t${i}`, name: 'exec', arguments: { command: `run-${i}.sh` } }] })
    messages.push(recordedResult(`t${i}`, 'exec', { exit: 0 }))
  }
  return messages
}

describe('what an overflow drop leaves the model', () => {
  const answering = (throwsFirst) => {
    let calls = 0
    return {
      answer: async () => {
        if (calls++ < throwsFirst) throw overflow()
        return { status: 'completed', output: 'ok' }
      },
      info: () => ({ contextTokenLimit: 200000 })
    }
  }

  it('hands back the facts, not just their number', async () => {
    const messages = history()
    const sessionMemory = createSessionMemory()
    const model = withRecovery(answering(1), { messages, sessionMemory })

    await model.answer(() => ({ system: 's', messages }), {})

    const notice = messages.find(m => marked(m, CONTEXT_NOTICE))
    expect(notice).toBeDefined()
    expect(notice.content).toMatch(/What was dropped, in brief/)
    expect(notice.content).toMatch(/exec\(run-0\.sh\) — exit 0/)
    expect(notice.content).not.toMatch(/facts preserved in session memory/)
  })

  it('says only that context was reduced when there is nothing to hand back', async () => {
    const messages = history()
    const model = withRecovery(answering(1), { messages })

    await model.answer(() => ({ system: 's', messages }), {})

    const notice = messages.find(m => marked(m, CONTEXT_NOTICE))
    expect(notice.content).toMatch(/context was reduced to fit budget/)
    expect(notice.content).not.toMatch(/What was dropped/)
  })

  it('extracts from the messages that were dropped, not the ones that survived', async () => {
    const messages = history()
    const sessionMemory = createSessionMemory()
    const model = withRecovery(answering(1), { messages, sessionMemory })

    await model.answer(() => ({ system: 's', messages }), {})

    const facts = sessionMemory.getFacts().map(f => f.text).join('\n')
    expect(facts).toMatch(/run-0\.sh/)
    expect(facts).not.toMatch(/run-5\.sh/)
  })
})
