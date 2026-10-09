import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sanitizeTranscript } from '../src/resilience/transcript.js'
import { makeTools } from '../src/tools/make-tools.js'
import { createCallTrail } from '../src/core/call-record.js'
import { hostState } from '../src/core/spore-dir.js'
import { shownToModel } from './fixtures/as-shown.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.result-budget-workspace')

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(resolve(WS, 'data'), { recursive: true })
})

afterEach(() => {
  rmSync(WS, { recursive: true, force: true })
})

// Two budgets used to be applied to two different things. `read` measured the bytes it
// sliced; the transcript sanitiser measured the serialized record, which is bigger by
// its own metadata and by JSON escaping. A file that just fit the first came back over
// the second and was cut mid-object.
describe('one budget, on what the model actually receives', () => {
  it('keeps a read within budget as a whole record, not just its content', async () => {
    const budget = 6000
    writeFileSync(resolve(WS, 'data/big.txt'), 'x'.repeat(budget - 100) + '\n')
    const read = shownToModel(makeTools(WS, budget, createCallTrail(WS, { runId: 'test', state: hostState(WS) })).fns).read

    const result = await read({ path: 'data/big.txt' })
    // Either it fits whole, or it is refused — never a record over budget.
    if (result.startsWith('error:')) {
      expect(result).toMatch(/over the 6000 budget — ask for fewer/)
    } else {
      expect(result.length).toBeLessThanOrEqual(budget)
      expect(() => JSON.parse(result)).not.toThrow()
    }
  })

  it('refuses rather than returning a record the transcript would cut', async () => {
    const budget = 4000
    writeFileSync(resolve(WS, 'data/edge.txt'), 'y'.repeat(budget - 20) + '\n')
    const read = shownToModel(makeTools(WS, budget, createCallTrail(WS, { runId: 'test', state: hostState(WS) })).fns).read

    const result = await read({ path: 'data/edge.txt' })
    expect(result.startsWith('error:')).toBe(true)
    expect(result).toMatch(/ask for fewer/)
  })

  it('leaves a readable record when the sanitiser has to cut one anyway', () => {
    const record = JSON.stringify({ tool: 'read', path: 'data/x.md', bytes: 90000, lines: 2000, content: 'z'.repeat(9000) })
    // With its assistant message: an orphan tool result is dropped, not truncated.
    const messages = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'data/x.md' } }] },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: record }
    ]

    sanitizeTranscript(messages, { maxResultSize: 500 })

    const kept = messages.find(m => m.role === 'tool').content
    expect(kept.length).toBeLessThanOrEqual(500)
    // Still a record: the agent can see which file and how big, and go read it.
    const parsed = JSON.parse(kept)
    expect(parsed.path).toBe('data/x.md')
    expect(parsed.lines).toBe(2000)
    expect(parsed.content).toBeUndefined()
    expect(parsed.dropped).toMatch(/content \(9000 chars\)/)
  })
})
