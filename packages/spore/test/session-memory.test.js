import { describe, it, expect } from 'vitest'
import { createSessionMemory } from '../src/resilience/session-memory.js'
import { silent } from '../src/observability/logger.js'
import { isRefusal, refuse, refusedResult } from '../src/core/refusal.js'
import { isRecorded, recorded, recordedResult } from '../src/core/call-record.js'

describe('session-memory', () => {
  // ── Extract: user messages ────────────────────────────────────────

  it('extracts from user messages', () => {
    const sm = createSessionMemory({ logger: silent })
    sm.extract([{ role: 'user', content: 'Migrate the project to ESM' }])
    const facts = sm.getFacts()
    expect(facts).toHaveLength(1)
    expect(facts[0].text).toBe('Migrate the project to ESM')
  })

  it('ignores short user messages', () => {
    const sm = createSessionMemory({ logger: silent })
    sm.extract([{ role: 'user', content: 'ok' }])
    expect(sm.getFacts()).toHaveLength(0)
  })

  it('truncates long user content', () => {
    const sm = createSessionMemory({ logger: silent })
    sm.extract([{ role: 'user', content: 'x'.repeat(500) }])
    expect(sm.getFacts()[0].text.length).toBeLessThanOrEqual(200)
  })

  // ── Extract: standalone assistant ─────────────────────────────────

  it('extracts from standalone assistant messages', () => {
    const sm = createSessionMemory({ logger: silent })
    sm.extract([{ role: 'assistant', content: 'I decided to use node:test instead of vitest because it has no dependencies.' }])
    const facts = sm.getFacts()
    expect(facts).toHaveLength(1)
    expect(facts[0].text).toContain('node:test instead of vitest')
  })

  it('ignores short assistant messages', () => {
    const sm = createSessionMemory({ logger: silent })
    sm.extract([{ role: 'assistant', content: 'Done.' }])
    expect(sm.getFacts()).toHaveLength(0)
  })

  it('truncates long assistant content', () => {
    const sm = createSessionMemory({ logger: silent })
    sm.extract([{ role: 'assistant', content: 'a'.repeat(500) }])
    expect(sm.getFacts()[0].text.length).toBeLessThanOrEqual(300)
  })

  // ── Extract: turn-group compression ───────────────────────────────

  const record = (fields) => recorded(fields)

  const group = (calls) => [
    { role: 'assistant', content: '', toolCalls: calls.map(([name, args], i) => ({ id: `tc${i}`, name, arguments: args })) },
    ...calls.map(([name, , content], i) => (isRefusal(content)
      ? refusedResult(`tc${i}`, name, content.refused)
      : isRecorded(content)
        ? recordedResult(`tc${i}`, name, content.record)
        : { role: 'tool', toolCallId: `tc${i}`, toolName: name, content }))
  ]

  const factFor = (name, args, content) => {
    const sm = createSessionMemory({ logger: silent })
    sm.extract(group([[name, args, content]]))
    return sm.getFacts()[0].text
  }

  it('compresses assistant + tool calls + results into one fact', () => {
    const sm = createSessionMemory({ logger: silent })
    sm.extract([
      {
        role: 'assistant',
        content: 'Let me check the config first',
        toolCalls: [{ id: 'tc1', name: 'read', arguments: { path: 'config.js' } }]
      },
      recordedResult('tc1', 'read', { tool: 'read', path: 'config.js', lines: 2, eof: true, content: 'port=3000\nhost=localhost' })
    ])
    const facts = sm.getFacts()
    expect(facts).toHaveLength(1)
    expect(facts[0].text).toContain('check the config')
    expect(facts[0].text).toContain('read(config.js) — 2 lines')
  })

  it('compresses multiple tool calls in one turn', () => {
    const sm = createSessionMemory({ logger: silent })
    sm.extract(group([
      ['read', { path: 'a.js' }, record({ tool: 'read', lines: 3, eof: true })],
      ['read', { path: 'b.js' }, record({ tool: 'read', lines: 1, eof: false })]
    ]))
    const facts = sm.getFacts()
    expect(facts).toHaveLength(1)
    expect(facts[0].text).toContain('read(a.js) — 3 lines')
    expect(facts[0].text).toContain('read(b.js) — 1 lines, more follows')
  })

  it('handles assistant with tool calls but no text content', () => {
    const text = factFor('exec', { command: 'find . -name "*.js"' }, record({ tool: 'exec', exit: 0, files: { out: { path: 'data/f.txt', bytes: 300 } } }))
    expect(text).toContain('exec(find . -name "*.js") — 300 bytes out')
    // No reasoning prefix, since the assistant said nothing.
    expect(text).not.toContain('→')
  })

  // ── What a call did ───────────────────────────────────────────────
  //
  // These were ten per-tool extractors written against v2's shapes, and two of them
  // had gone quietly wrong: `exec` looked for a textual `exit N` and so reported
  // success for every failure, and `write` read `args.path` where v3 names the target
  // `out`. Facts go back to the model as what happened earlier, so a wrong one is
  // worse than none. Every case below is a real v3 record.

  it('reports the exit code a command actually returned', () => {
    expect(factFor('exec', { command: 'grep -c ERROR big.log' }, record({ tool: 'exec', exit: 7, files: { out: { path: 'data/o.txt', bytes: 0 } } })))
      .toContain('exec(grep -c ERROR big.log) — exit 7')
  })

  it('says a command was killed, rather than what it wrote before it was', () => {
    expect(factFor('wsexec', { command: 'npm test' }, record({ tool: 'wsexec', signal: 'SIGTERM', killed: 'idle', files: { out: { path: 'data/t.log', bytes: 812 } } })))
      .toContain('wsexec(npm test) — killed: idle')
    expect(factFor('exec', { command: 'node crash.js' }, record({ tool: 'exec', signal: 'SIGSEGV', files: { out: { path: 'data/c.log', bytes: 0 } } })))
      .toContain('exec(node crash.js) — ended by SIGSEGV')
  })

  it('names what a write wrote, and how much', () => {
    expect(factFor('write', { out: 'data/answer.txt' }, record({ tool: 'write', exit: 0, files: { out: { path: 'data/answer.txt', bytes: 240 } } })))
      .toContain('write(data/answer.txt) — 240 bytes out')
  })

  it('covers wsexec, which had no extractor at all', () => {
    expect(factFor('wsexec', { command: 'node build.js' }, record({ tool: 'wsexec', exit: 0, files: { out: { path: 'data/b.log', bytes: 91 } } })))
      .toContain('wsexec(node build.js) — 91 bytes out')
  })

  it('says an edit replaced something', () => {
    expect(factFor('edit', { out: 'src/a.js' }, record({ tool: 'edit', exit: 0, replaced: 1 })))
      .toContain('edit(src/a.js) — replaced')
  })

  it('records a refusal as a refusal', () => {
    expect(factFor('edit', { out: 'data/gone.js' }, refuse('not found — data/gone.js')))
      .toContain('edit(data/gone.js) — refused: not found — data/gone.js')
  })

  it('reads a question written as JSON with an exit code as a question, not a command that failed', () => {
    const fact = factFor('ask', {}, '{"exit":1,"question":"Which file should I read first, the report or the log?"}')
    expect(fact).not.toMatch(/exit 1/)
    expect(fact).toContain('Which file')
  })

  it('reads a result that only looks like a refusal as what it is', () => {
    expect(factFor('ask', {}, 'error: the build fails on node 22 — which version should I target?'))
      .not.toContain('refused')
  })

  it('reads a byte-ranged read', () => {
    expect(factFor('read', { path: 'data/blob.bin' }, record({ tool: 'read', bytesRead: 4096, eof: false })))
      .toContain('read(data/blob.bin) — 4096 bytes')
  })

  it('falls back to the result for a tool that returns no record', () => {
    const text = factFor('ask', { question: 'which region?' }, 'which region should I use for the rollout, us-east or eu-west?')
    expect(text).toContain('ask(')
    expect(text).toContain('which region')
  })

  it('includes reasoning prefix when assistant has content', () => {
    const sm = createSessionMemory({ logger: silent })
    sm.extract([
      {
        role: 'assistant',
        content: 'The config is missing the database URL, let me fix it',
        toolCalls: [{ id: 'tc1', name: 'edit', arguments: { out: 'config.js', old: 'a', new: 'b' } }]
      },
      recordedResult('tc1', 'edit', { tool: 'edit', exit: 0, replaced: 1 })
    ])
    const text = sm.getFacts()[0].text
    expect(text).toContain('config is missing the database URL')
    expect(text).toContain('→')
    expect(text).toContain('edit(config.js) — replaced')
  })

  // ── Orphan tool_result fallback ───────────────────────────────────

  it('handles orphan tool_result as fallback', () => {
    const sm = createSessionMemory({ logger: silent })
    sm.extract([
      { role: 'tool', toolName: 'grep', content: 'src/index.js:5:export function main() { console.log("hello"); return 42; }' }
    ])
    const facts = sm.getFacts()
    expect(facts).toHaveLength(1)
    expect(facts[0].text).toMatch(/^grep\(\)/)
  })

  it('ignores compacted markers', () => {
    const sm = createSessionMemory({ logger: silent })
    sm.extract([
      { role: 'tool', toolName: 'read', content: '[compacted — re-read if needed]' }
    ])
    expect(sm.getFacts()).toHaveLength(0)
  })

  it('ignores short tool results', () => {
    const sm = createSessionMemory({ logger: silent })
    sm.extract([
      { role: 'tool', toolName: 'write', content: 'ok' }
    ])
    expect(sm.getFacts()).toHaveLength(0)
  })

  // ── Mixed extraction ──────────────────────────────────────────────

  it('produces fewer facts from mixed messages via turn-group compression', () => {
    const sm = createSessionMemory({ logger: silent })
    sm.extract([
      { role: 'user', content: 'Fix the login bug' },
      {
        role: 'assistant',
        content: 'I found the issue in auth.js',
        toolCalls: [{ id: 'tc1', name: 'exec', arguments: { command: 'grep -n token.valid auth.js' } }]
      },
      recordedResult('tc1', 'exec', { tool: 'exec', exit: 0, files: { out: { path: 'data/hits.txt', bytes: 58 } } })
    ])
    // User + one turn-group = 2 facts, not one per message.
    expect(sm.getFacts()).toHaveLength(2)
    expect(sm.getFacts()[0].text).toBe('Fix the login bug')
    expect(sm.getFacts()[1].text).toContain('exec(grep -n token.valid auth.js) — 58 bytes out')
  })

  // ── Edge cases ────────────────────────────────────────────────────

  it('handles empty messages array', () => {
    const sm = createSessionMemory({ logger: silent })
    sm.extract([])
    expect(sm.getFacts()).toHaveLength(0)
  })

  it('handles null/undefined', () => {
    const sm = createSessionMemory({ logger: silent })
    sm.extract(null)
    sm.extract(undefined)
    expect(sm.getFacts()).toHaveLength(0)
  })

  it('accumulates facts across multiple extract calls', () => {
    const sm = createSessionMemory({ logger: silent })
    sm.extract([{ role: 'user', content: 'First task' }])
    sm.extract([{ role: 'user', content: 'Second task' }])
    expect(sm.getFacts()).toHaveLength(2)
  })

  it('handles tool calls with missing result (no matching tool_result)', () => {
    const sm = createSessionMemory({ logger: silent })
    sm.extract([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'read', arguments: { path: 'x.js' } }]
      }
      // No tool_result — interrupted or compacted
    ])
    const facts = sm.getFacts()
    expect(facts).toHaveLength(1)
    expect(facts[0].text).toContain('read(x.js)')
  })

  // ── Format ────────────────────────────────────────────────────────

  it('returns null when empty', () => {
    const sm = createSessionMemory({ logger: silent })
    expect(sm.format()).toBeNull()
  })

  it('returns formatted string with facts', () => {
    const sm = createSessionMemory({ logger: silent })
    sm.extract([{ role: 'user', content: 'Migrate to ESM' }])
    const formatted = sm.format()
    expect(formatted).toContain('[Session context from earlier work]')
    expect(formatted).toContain('- Migrate to ESM')
  })

  // ── Budget ────────────────────────────────────────────────────────

  it('trims oldest facts past a hundred of them', () => {
    const sm = createSessionMemory({ logger: silent })
    for (let i = 0; i < 102; i++) {
      sm.extract([{ role: 'user', content: `Task number ${i}` }])
    }
    const facts = sm.getFacts()
    expect(facts).toHaveLength(100)
    expect(facts[0].text).toBe('Task number 2')
    expect(facts[99].text).toBe('Task number 101')
  })

  it('trims oldest facts past 8000 characters of them', () => {
    const sm = createSessionMemory({ logger: silent })
    for (let i = 0; i < 50; i++) {
      sm.extract([{ role: 'user', content: `fact ${i} ` + 'x'.repeat(300) }])
    }
    const facts = sm.getFacts()
    expect(facts.reduce((total, fact) => total + fact.text.length, 0)).toBeLessThanOrEqual(8000)
    expect(facts[0].text).not.toMatch(/^fact 0 /)
    expect(facts.at(-1).text).toMatch(/^fact 49 /)
  })
})
