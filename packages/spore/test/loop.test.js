import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loop } from '../src/core/loop.js'
import { WRAP, marked } from '../src/core/marks.js'
import { SporeError } from '../src/observability/errors.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.loop-workspace')

/* ── Mock model factory ──────────────────────────────────────────── */

function mockModel (responses) {
  let i = 0
  const calls = []
  return {
    answer: async (prompt, opts) => {
      calls.push({ prompt, opts })
      if (i >= responses.length) throw new Error('Mock exhausted — unexpected extra call')
      return responses[i++]
    },
    calls
  }
}

function toolUse (calls) {
  return {
    status: 'tool_use',
    output: '',
    toolCalls: calls.map((c, i) => ({ id: `call_${i}`, name: c.name, arguments: c.args }))
  }
}

function completed (text) {
  return { status: 'completed', output: text }
}

/* ── Minimal tool set for testing ────────────────────────────────── */

function makeToolFns () {
  return {
    read: ({ path }) => readFileSync(resolve(WS, path), 'utf8'),
    write: ({ path, content }) => { writeFileSync(resolve(WS, path), content); return 'ok' },
    exec: ({ command }) => `exec: ${command}`,
    echo: ({ text }) => text,
    fail: () => { throw new Error('boom') }
  }
}

const TOOLS = [
  { name: 'read', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'write', description: 'Write file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'exec', description: 'Run command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'echo', description: 'Echo text', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'fail', description: 'Always fail', parameters: { type: 'object', properties: {}, required: [] } }
]

/* ── Tests ────────────────────────────────────────────────────────── */

describe('a cell\'s spend against its parent\'s ceiling', () => {
  const LIMITS = { rounds: { soft: 10, hard: 12 }, cost: { soft: 0.4, hard: 0.5 } }

  it('counts what its children spent as its own', async () => {
    const m = mockModel([{ status: 'completed', output: 'done' }])
    const ledger = { own: 0, children: 0.6 }
    const res = await loop({ limits: LIMITS, ledger, model: m, system: 'sys', prompt: 'q', tools: TOOLS, toolFns: makeToolFns() })
    // The parent itself has spent nothing; the tree has spent past the hard bound.
    expect(res.stopReason).toBe('hard:cost')
    expect(res.spent.cost).toBeCloseTo(0.6)
    expect(m.calls).toHaveLength(0)
  })

  it('leaves a parent with cheap children alone', async () => {
    const m = mockModel([{ status: 'completed', output: 'done' }])
    const res = await loop({ limits: LIMITS, ledger: { own: 0, children: 0.01 }, model: m, system: 'sys', prompt: 'q', tools: TOOLS, toolFns: makeToolFns() })
    expect(res.stopReason).toBe('answer')
  })
})

// The system blocks carried breakpoints and the history carried none, so a conversation
// was re-sent at full price on every round however long it grew. mohdel takes the opt-in
// from a `cache` marker on a message part and places the breakpoints itself.
describe('conversation prefix caching', () => {
  const history = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' }
  ]

  it('marks the last message so mohdel caches the conversation', async () => {
    const m = mockModel([completed('ok')])
    await loop({
      limits: { rounds: { soft: 10, hard: 12 } },
      model: m,
      system: 'sys',
      prompt: 'next',
      tools: TOOLS,
      toolFns: makeToolFns(),
      initialMessages: history,
      cacheTtl: '1h'
    })
    const sent = m.calls[0].prompt
    expect(sent.at(-1).content).toEqual([{ type: 'text', text: 'next', cache: '1h' }])
    // Only the last one: mohdel places the rest of the breakpoints itself.
    expect(sent[1].content).toBe('first question')
  })

  it('leaves the live transcript as strings', async () => {
    const m = mockModel([completed('ok')])
    const res = await loop({
      limits: { rounds: { soft: 10, hard: 12 } },
      model: m,
      system: 'sys',
      prompt: 'next',
      tools: TOOLS,
      toolFns: makeToolFns(),
      initialMessages: history,
      cacheTtl: '1h'
    })
    // `estimateTokens` reads `content.length`. A marked message on the live array would
    // weigh one token instead of its own size, and every budget would be computed
    // against that.
    for (const msg of res.messages) expect(typeof msg.content).toBe('string')
  })

  it('does not mark a turn with no history to cache', async () => {
    const m = mockModel([completed('ok')])
    await loop({
      limits: { rounds: { soft: 10, hard: 12 } },
      model: m,
      system: 'sys',
      prompt: 'only message',
      tools: TOOLS,
      toolFns: makeToolFns(),
      cacheTtl: '1h'
    })
    // One message pays the cache-write premium with nothing ever reading it back.
    expect(m.calls[0].prompt.at(-1).content).toBe('only message')
  })

  it('sends the history untouched when no ttl is asked for', async () => {
    const m = mockModel([completed('ok')])
    await loop({
      limits: { rounds: { soft: 10, hard: 12 } },
      model: m,
      system: 'sys',
      prompt: 'next',
      tools: TOOLS,
      toolFns: makeToolFns(),
      initialMessages: history
    })
    expect(m.calls[0].prompt.at(-1).content).toBe('next')
  })
})

describe('tool loop', () => {
  beforeAll(() => {
    mkdirSync(WS, { recursive: true })
    writeFileSync(resolve(WS, 'readme.txt'), 'hello world')
  })

  afterAll(() => {
    rmSync(WS, { recursive: true, force: true })
  })

  // ── Basic flow ──────────────────────────────────────────────────

  it('returns immediately on completed (no tool calls)', async () => {
    const m = mockModel([completed('The answer is 42')])
    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'q', tools: TOOLS, toolFns: makeToolFns() })
    expect(res.output).toBe('The answer is 42')
    expect(res.rounds).toBe(1)
    expect(res.messages).toHaveLength(1) // just the user message
  })

  it('nudges and recovers when a completion is empty', async () => {
    const m = mockModel([completed(''), completed('Right')])
    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'q', tools: TOOLS, toolFns: makeToolFns() })
    expect(res.output).toBe('Right')
    expect(res.rounds).toBe(2)
    // user → (empty turn placeholder + nudge) → recovered answer
    expect(m.calls).toHaveLength(2)
    expect(res.messages.some(msg => msg.role === 'user' && /empty/i.test(msg.content))).toBe(true)
  })

  it('gives up after the empty-retry cap (no infinite loop)', async () => {
    const m = mockModel([completed(''), completed('  '), completed(null)])
    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'q', tools: TOOLS, toolFns: makeToolFns() })
    expect(res.output).toBeNull()
    expect(m.calls).toHaveLength(3) // original + MAX_EMPTY_RETRIES (2)
  })

  it('executes one tool call then returns final answer', async () => {
    const m = mockModel([
      toolUse([{ name: 'echo', args: { text: 'pong' } }]),
      completed('Done')
    ])
    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'q', tools: TOOLS, toolFns: makeToolFns() })
    expect(res.output).toBe('Done')
    expect(res.rounds).toBe(2)
    // user → assistant (tool_calls) → tool_result → (second call yields completed)
    expect(res.messages).toHaveLength(3)
    expect(res.messages[1].toolCalls[0].name).toBe('echo')
    expect(res.messages[2].role).toBe('tool')
    expect(res.messages[2].content).toBe('pong')
  })

  it('executes multiple turns of tool calls', async () => {
    const m = mockModel([
      toolUse([{ name: 'echo', args: { text: 'step1' } }]),
      toolUse([{ name: 'echo', args: { text: 'step2' } }]),
      toolUse([{ name: 'echo', args: { text: 'step3' } }]),
      completed('All done')
    ])
    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'q', tools: TOOLS, toolFns: makeToolFns() })
    expect(res.output).toBe('All done')
    expect(res.rounds).toBe(4)
  })

  // ── Parallel tool calls ───────────────────────────────────────

  it('handles multiple tool calls in a single turn', async () => {
    const m = mockModel([
      toolUse([
        { name: 'echo', args: { text: 'a' } },
        { name: 'echo', args: { text: 'b' } }
      ]),
      completed('Got both')
    ])
    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'q', tools: TOOLS, toolFns: makeToolFns() })
    expect(res.output).toBe('Got both')
    const toolResults = res.messages.filter(m => m.role === 'tool')
    expect(toolResults).toHaveLength(2)
    expect(toolResults[0].content).toBe('a')
    expect(toolResults[1].content).toBe('b')
  })

  // ── Real tool execution ───────────────────────────────────────

  it('read tool returns file contents', async () => {
    const m = mockModel([
      toolUse([{ name: 'read', args: { path: 'readme.txt' } }]),
      completed('File says hello')
    ])
    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'q', tools: TOOLS, toolFns: makeToolFns() })
    const result = res.messages.find(m => m.role === 'tool')
    expect(result.content).toBe('hello world')
  })

  it('write tool creates file in workspace', async () => {
    const m = mockModel([
      toolUse([{ name: 'write', args: { path: 'created.txt', content: 'new file' } }]),
      completed('Wrote it')
    ])
    await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'q', tools: TOOLS, toolFns: makeToolFns() })
    expect(readFileSync(resolve(WS, 'created.txt'), 'utf8')).toBe('new file')
  })

  // ── Error handling ────────────────────────────────────────────

  it('tool error is captured and sent back as tool_result', async () => {
    const m = mockModel([
      toolUse([{ name: 'fail', args: {} }]),
      completed('I see the error')
    ])
    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'q', tools: TOOLS, toolFns: makeToolFns() })
    const result = res.messages.find(m => m.role === 'tool')
    expect(result.content).toBe('error: boom')
    expect(res.output).toBe('I see the error')
  })

  it('read of missing file returns error', async () => {
    const m = mockModel([
      toolUse([{ name: 'read', args: { path: 'nope.txt' } }]),
      completed('File not found')
    ])
    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'q', tools: TOOLS, toolFns: makeToolFns() })
    const result = res.messages.find(m => m.role === 'tool')
    expect(result.content).toMatch(/error:.*ENOENT/)
  })

  // ── Max turns ─────────────────────────────────────────────────

  const busy = (n) => mockModel(Array.from({ length: n }, () => toolUse([{ name: 'echo', args: { text: 'loop' } }])))
  const run = (over) => loop({
    system: 'sys', prompt: 'q', tools: TOOLS, toolFns: makeToolFns(), ...over
  })

  it('stops at the hard round limit with nothing to show', async () => {
    const res = await run({ model: busy(9), limits: { rounds: { soft: 3, hard: 5 } } })
    expect(res.output).toBeNull()
    expect(res.stopReason).toBe('hard:rounds')
    expect(res.rounds).toBe(5)
  })

  it('wraps at the soft limit rather than stopping, and says so once', async () => {
    const m = mockModel([
      toolUse([{ name: 'echo', args: { text: 'a' } }]),
      toolUse([{ name: 'echo', args: { text: 'b' } }]),
      completed('done')
    ])
    const res = await run({ model: m, limits: { rounds: { soft: 2, hard: 9 } } })
    expect(res.output).toBe('done')
    expect(res.stopReason).toBe('soft:rounds')
    const notices = res.messages.filter(msg => marked(msg, WRAP))
    expect(notices).toHaveLength(1)
    expect(notices[0].content).toMatch(/reached its rounds limit \(2 rounds\)/)
    expect(notices[0].content).toMatch(/what is unfinished/)
  })

  it('carries on when its owner raises the limit it wrapped on, and is told so once', async () => {
    const limits = { rounds: { soft: 2, hard: 9 } }
    let looks = 0
    const relimited = () => {
      if (++looks !== 4) return []
      limits.rounds = { soft: 5, hard: 12 }
      return [{ dimension: 'rounds', why: 'extend', soft: 5, hard: 12, was: { soft: 2, hard: 9 } }]
    }
    const m = mockModel([
      toolUse([{ name: 'echo', args: { text: 'a' } }]),
      toolUse([{ name: 'echo', args: { text: 'b' } }]),
      toolUse([{ name: 'echo', args: { text: 'c' } }]),
      completed('done')
    ])
    const res = await run({ model: m, limits, relimited })
    expect(res.stopReason).toBe('answer')
    const notices = res.messages.filter(msg => marked(msg, WRAP)).map(msg => msg.content)
    expect(notices).toHaveLength(2)
    expect(notices[1]).toMatch(/raised this turn's rounds limit — it now wraps at 5 rounds and stops at 12 rounds\. Disregard the request to wrap up/)
  })

  it('wraps when its owner asks, and says that is why', async () => {
    const limits = { rounds: { soft: 90, hard: 99 }, wall: { soft: 600_000, hard: 900_000 } }
    let looks = 0
    const relimited = () => {
      if (++looks !== 2) return []
      limits.wall = { soft: 0, hard: 900_000 }
      return [{ dimension: 'wall', why: 'wrap', soft: 0, hard: 900_000, was: { soft: 600_000, hard: 900_000 } }]
    }
    const m = mockModel([toolUse([{ name: 'echo', args: { text: 'a' } }]), completed('wrapped up')])
    const res = await run({ model: m, limits, relimited })
    expect(res.stopReason).toBe('soft:wall')
    const notices = res.messages.filter(msg => marked(msg, WRAP))
    expect(notices).toHaveLength(1)
    expect(notices[0].content).toMatch(/this turn has been asked by its owner to wrap up/)
  })

  it('reports a plain answer as such', async () => {
    const res = await run({ model: mockModel([completed('hi')]), limits: { rounds: { soft: 5, hard: 9 } } })
    expect(res.stopReason).toBe('answer')
  })

  it('never takes a cut-off reply for an answer', async () => {
    const cut = { status: 'incomplete', output: 'One PR per P0, starting with', warning: 'insufficientOutputBudget' }
    await expect(run({ model: mockModel([cut]), limits: { rounds: { soft: 5, hard: 9 } } }))
      .rejects.toMatchObject({ type: 'MODEL_REPLY_INCOMPLETE', detail: 'round 0: insufficientOutputBudget' })
  })

  it('never drops tool calls a reply carries, whatever its status says', async () => {
    const ran = []
    const toolFns = { ...makeToolFns(), echo: ({ text }) => { ran.push(text); return text } }
    const promise = { status: 'completed', output: 'Starting with #56.', toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: 'x' } }] }
    await expect(run({ model: mockModel([promise]), toolFns, limits: { rounds: { soft: 5, hard: 9 } } }))
      .rejects.toMatchObject({ type: 'MODEL_REPLY_INCONSISTENT' })
    expect(ran).toEqual([])
  })

  it('keeps the reasoning a provider carries across rounds, and sends it back', async () => {
    const thought = { type: 'reasoning', text: '', encrypted: 'opaque', id: 'rs_1' }
    const m = mockModel([{ ...toolUse([{ name: 'echo', args: { text: 'x' } }]), reasoningParts: [thought] }, completed('done')])
    const res = await run({ model: m, limits: { rounds: { soft: 5, hard: 9 } } })
    const recorded = res.messages.find(msg => msg.role === 'assistant' && msg.toolCalls)
    expect(recorded.content[0]).toEqual(thought)
    const second = m.calls[1].prompt
    const sent = (typeof second === 'function' ? second() : second).find(msg => msg.role === 'assistant' && msg.toolCalls)
    expect(sent.content[0]).toEqual(thought)
  })

  it('refuses a tool_use reply with no tool call in it', async () => {
    await expect(run({ model: mockModel([{ status: 'tool_use', output: 'x', toolCalls: [] }]), limits: { rounds: { soft: 5, hard: 9 } } }))
      .rejects.toMatchObject({ type: 'MODEL_REPLY_INCONSISTENT' })
  })

  it('stops on cost, which only a model call can raise', async () => {
    const spend = { status: 'tool_use', output: '', cost: 0.4, toolCalls: [{ id: 'c', name: 'echo', arguments: { text: 'x' } }] }
    const m = mockModel([spend, spend, spend, spend])
    const res = await run({ model: m, limits: { rounds: { soft: 90, hard: 99 }, cost: { soft: 0.5, hard: 0.7 } } })
    expect(res.stopReason).toBe('hard:cost')
    expect(res.spent.cost).toBeGreaterThanOrEqual(0.7)
  })

  it('stops when the spend limit is reached, with the rounds it got through', async () => {
    const refusing = {
      answer: async () => { throw new SporeError('your spores have spent $20.00 today, which reaches your daily limit of $20.00', { type: 'SPEND_LIMIT', detail: 'turns start again tomorrow' }) }
    }
    const res = await run({ model: refusing, limits: { rounds: { soft: 3, hard: 5 } } })
    expect(res).toMatchObject({ output: null, stopReason: 'hard:spend', rounds: 0 })
  })

  it('wraps on cost before it stops on cost', async () => {
    const spend = { status: 'tool_use', output: '', cost: 0.4, toolCalls: [{ id: 'c', name: 'echo', arguments: { text: 'x' } }] }
    const m = mockModel([spend, completed('wrapped up')])
    const res = await run({ model: m, limits: { rounds: { soft: 90, hard: 99 }, cost: { soft: 0.3, hard: 9 } } })
    expect(res.stopReason).toBe('soft:cost')
    expect(res.messages.filter(msg => marked(msg, WRAP))).toHaveLength(1)
  })

  it('stops on the wall clock', async () => {
    const slow = async () => { await new Promise(resolve => setTimeout(resolve, 40)); return toolUse([{ name: 'echo', args: { text: 'x' } }]) }
    const m = { answer: slow }
    const res = await run({ model: m, limits: { rounds: { soft: 90, hard: 99 }, wall: { soft: 10, hard: 60 } } })
    expect(res.stopReason).toBe('hard:wall')
  })

  it('wraps when a tool has stopped making progress, without taking it away', async () => {
    // Distinct arguments each time, so this is the failure detector and not the
    // exact-repeat one — the two catch different things.
    const failing = (n) => toolUse([{ name: 'fail', args: { attempt: n } }])
    const m = mockModel([failing(1), failing(2), failing(3), failing(4), failing(5), completed('what I have')])
    const res = await run({ model: m, limits: { rounds: { soft: 90, hard: 99 } } })
    expect(res.output).toBe('what I have')
    expect(res.stopReason).toBe('soft:progress')
    const notice = res.messages.find(msg => marked(msg, WRAP))
    expect(notice.content).toMatch(/stopped making progress/)
    expect(notice.content).toMatch(/`fail` has failed 5 times in a row/)
  })

  it('refuses to run without declared round limits', async () => {
    await expect(run({ model: mockModel([completed('x')]) })).rejects.toThrow(/limits.rounds/)
    await expect(run({ model: mockModel([completed('x')]), limits: { rounds: { soft: 3 } } })).rejects.toThrow(/limits.rounds/)
  })

  // ── Message structure ─────────────────────────────────────────

  it('passes system prompt and accumulates message history', async () => {
    const m = mockModel([
      toolUse([{ name: 'echo', args: { text: 'x' } }]),
      completed('done')
    ])
    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'Be brief', prompt: 'hi', tools: TOOLS, toolFns: makeToolFns() })

    // System prompt passed on every call
    expect(m.calls[0].prompt[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'Be brief' }] })
    expect(m.calls[1].prompt[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'Be brief' }] })

    // Two model calls were made
    expect(m.calls).toHaveLength(2)

    // Final message history: user → assistant → tool_result
    expect(res.messages).toHaveLength(3)
    expect(res.messages[0]).toEqual({ role: 'user', content: 'hi' })
    expect(res.messages[1].role).toBe('assistant')
    expect(res.messages[2].role).toBe('tool')
  })

  it('tool_result includes toolCallId and toolName', async () => {
    const m = mockModel([
      toolUse([{ name: 'echo', args: { text: 'hi' } }]),
      completed('ok')
    ])
    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'q', tools: TOOLS, toolFns: makeToolFns() })
    const result = res.messages.find(m => m.role === 'tool')
    expect(result.toolCallId).toBe('call_0')
    expect(result.toolName).toBe('echo')
    expect(result.content).toBe('hi')
  })

  // ── Debug logging ─────────────────────────────────────────────

  it('calls log for each tool invocation', async () => {
    const logged = []
    const m = mockModel([
      toolUse([{ name: 'echo', args: { text: 'x' } }, { name: 'exec', args: { command: 'ls' } }]),
      completed('ok')
    ])
    await loop({
      limits: { rounds: { soft: 10, hard: 12 } },
      model: m,
      system: 'sys',
      prompt: 'q',
      tools: TOOLS,
      toolFns: makeToolFns(),
      logger: { trace () {}, debug (...a) { logged.push(a.map(v => typeof v === 'object' ? JSON.stringify(v) : v).join(' ')) }, info () {}, warn () {}, error () {}, fatal () {} }
    })
    expect(logged).toHaveLength(2)
    expect(logged[0]).toMatch(/echo/)
    expect(logged[1]).toMatch(/exec/)
  })

  // ── Usage tracking ──────────────────────────────────────────────

  it('accumulates token usage across turns', async () => {
    const m = mockModel([
      { status: 'tool_use', output: '', toolCalls: [{ id: 'c0', name: 'echo', arguments: { text: 'x' } }], inputTokens: 100, outputTokens: 20, thinkingTokens: 5 },
      { status: 'completed', output: 'done', inputTokens: 150, outputTokens: 30, thinkingTokens: 0 }
    ])
    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'q', tools: TOOLS, toolFns: makeToolFns() })
    expect(res.usage.input).toBe(250)
    expect(res.usage.output).toBe(50)
    expect(res.usage.thinking).toBe(5)
  })

  it('returns zero usage when model omits token fields', async () => {
    const m = mockModel([completed('hi')])
    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'q', tools: TOOLS, toolFns: makeToolFns() })
    expect(res.usage.input).toBe(0)
    expect(res.usage.output).toBe(0)
    expect(res.usage.thinking).toBe(0)
  })

  // ── Cancellation ──────────────────────────────────────────────

  it('returns cancelled when signal is pre-aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const m = mockModel([completed('hi')])
    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'q', tools: TOOLS, toolFns: makeToolFns(), signal: controller.signal })
    expect(res.cancelled).toBe(true)
    expect(res.rounds).toBe(0)
    expect(m.calls.length).toBe(0)
  })

  it('returns cancelled when signal fires mid-loop', async () => {
    const controller = new AbortController()
    const m = mockModel([
      toolUse([{ name: 'echo', args: { text: 'first' } }]),
      toolUse([{ name: 'echo', args: { text: 'second' } }]),
      completed('done')
    ])
    // Abort after first tool_use response is processed
    const origAnswer = m.answer
    let callCount = 0
    m.answer = async (...a) => {
      const res = await origAnswer(...a)
      callCount++
      if (callCount === 1) controller.abort() // abort after first answer
      return res
    }
    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'q', tools: TOOLS, toolFns: makeToolFns(), signal: controller.signal })
    expect(res.cancelled).toBe(true)
    expect(res.rounds).toBeLessThan(3)
  })

  it('ends cancelled when stopped during a batch, whatever else the batch held', async () => {
    const controller = new AbortController()
    const written = []
    const toolFns = {
      ...makeToolFns(),
      wsexec: () => { controller.abort(); return 'killed' },
      write: ({ path }) => { written.push(path); return 'ok' },
      quiet: ({ because }) => because
    }
    const m = mockModel([toolUse([
      { name: 'wsexec', args: { command: 'sleep 60' } },
      { name: 'write', args: { path: 'after.txt', content: 'x' } },
      { name: 'quiet', args: { because: 'nothing new' } }
    ])])
    const res = await loop({
      limits: { rounds: { soft: 10, hard: 12 } },
      model: m,
      system: 'sys',
      prompt: 'q',
      tools: TOOLS,
      toolFns,
      mutators: new Set(['wsexec', 'write']),
      terminalTools: new Map([['quiet', { stopReason: 'quiet', says: false }]]),
      signal: controller.signal
    })
    expect(written).toEqual([])
    expect(res.stopReason).toBe('cancelled')
    expect(res.cancelled).toBe(true)
    expect(res.messages.filter(msg => msg.role === 'tool')).toHaveLength(3)
  })

  it('completes normally when signal is never fired', async () => {
    const controller = new AbortController()
    const m = mockModel([completed('done')])
    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'q', tools: TOOLS, toolFns: makeToolFns(), signal: controller.signal })
    expect(res.cancelled).toBeUndefined()
    expect(res.output).toBe('done')
  })

  // ── onMessage hook ────────────────────────────────────────────

  it('onMessage fires for user, assistant, and tool_result messages', async () => {
    const received = []
    const m = mockModel([
      toolUse([{ name: 'echo', args: { text: 'hi' } }]),
      completed('done')
    ])
    await loop({
      limits: { rounds: { soft: 10, hard: 12 } },
      model: m,
      system: 'sys',
      prompt: 'q',
      tools: TOOLS,
      toolFns: makeToolFns(),
      onMessage: (msg) => received.push(msg)
    })
    expect(received).toHaveLength(3)
    expect(received[0]).toEqual({ role: 'user', content: 'q' })
    expect(received[1].role).toBe('assistant')
    expect(received[1].toolCalls).toBeDefined()
    expect(received[2].role).toBe('tool')
    expect(received[2].content).toBe('hi')
  })

  it('onMessage receives same objects as messages array', async () => {
    const received = []
    const m = mockModel([
      toolUse([{ name: 'echo', args: { text: 'x' } }]),
      completed('done')
    ])
    const res = await loop({
      limits: { rounds: { soft: 10, hard: 12 } },
      model: m,
      system: 'sys',
      prompt: 'q',
      tools: TOOLS,
      toolFns: makeToolFns(),
      onMessage: (msg) => received.push(msg)
    })
    for (let i = 0; i < received.length; i++) {
      expect(received[i]).toBe(res.messages[i])
    }
  })

  it('works normally when onMessage is omitted', async () => {
    const m = mockModel([completed('ok')])
    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'q', tools: TOOLS, toolFns: makeToolFns() })
    expect(res.output).toBe('ok')
  })

  // ── The system prompt is the first message ───────────────────────────────
  // Session memory composition happens in runSpore (composeSystem); loop.js sends it as a
  // wire `system` message, one text part per block.

  it('sends a string system as one text part', async () => {
    const m = mockModel([completed('done')])
    await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'Be brief', prompt: 'q', tools: TOOLS, toolFns: makeToolFns() })
    expect(m.calls[0].prompt[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'Be brief' }] })
  })

  // The breakpoint travels with its block: a flattened system prompt loses every one.
  it('sends each composed block as a text part, keeping its cache marker', async () => {
    const m = mockModel([completed('done')])
    const blocks = [
      { text: 'identity', cache: '5m' },
      { text: 'memory' }
    ]
    await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: blocks, prompt: 'q', tools: TOOLS, toolFns: makeToolFns() })
    expect(m.calls[0].prompt[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'identity', cache: '5m' }, { type: 'text', text: 'memory' }]
    })
  })

  it('works without session memory', async () => {
    const m = mockModel([completed('done')])
    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'q', tools: TOOLS, toolFns: makeToolFns() })
    expect(res.output).toBe('done')
    expect(m.calls[0].prompt[0].content[0].text).toBe('sys')
  })

  // ── Initial messages (fork context) ───────────────────────────

  it('prepends initialMessages before user prompt', async () => {
    const initial = [
      { role: 'user', content: 'prior question' },
      { role: 'assistant', content: 'prior answer' }
    ]
    const m = mockModel([completed('done')])
    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'new task', tools: TOOLS, toolFns: makeToolFns(), initialMessages: initial })
    expect(res.messages[0].content).toBe('prior question')
    expect(res.messages[1].content).toBe('prior answer')
    expect(res.messages[2].content).toBe('new task')
  })

  it('model receives initialMessages in first call', async () => {
    const initial = [{ role: 'assistant', content: 'context from parent' }]
    const m = mockModel([completed('done')])
    await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'task', tools: TOOLS, toolFns: makeToolFns(), initialMessages: initial })
    const msgs = m.calls[0].prompt
    expect(msgs[1].content).toBe('context from parent')
    expect(msgs[2].content).toBe('task')
  })

  it('works without initialMessages (backward compat)', async () => {
    const m = mockModel([completed('done')])
    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'q', tools: TOOLS, toolFns: makeToolFns() })
    expect(res.messages[0].content).toBe('q')
    expect(res.messages).toHaveLength(1)
  })

  it('recomputes context budget per turn from the chain head (RATE_LIMIT_TIER fallback)', async () => {
    // Two models with different context windows. Model A errors with
    // RATE_LIMIT_TIER on its first call; recovery shifts the chain to
    // B which then drives a tool-use round followed by a completed
    // round. The SECOND turn's computeBudget must read from B (the new
    // chain head) — that's the guarantee we're testing.
    const aInfoCalls = []
    const bInfoCalls = []
    const a = {
      id: 'a',
      info: () => { aInfoCalls.push(true); return { contextTokenLimit: 400000 } },
      answer: async () => {
        const err = new Error('rate limited'); err.type = 'RATE_LIMIT_TIER'; err.retryable = true; err.detail = 'tier'
        throw err
      }
    }
    let bAnswerCount = 0
    const b = {
      id: 'b',
      info: () => { bInfoCalls.push(true); return { contextTokenLimit: 65000 } },
      answer: async () => {
        bAnswerCount++
        if (bAnswerCount === 1) {
          return toolUse([{ name: 'echo', args: JSON.stringify({ text: 'hi' }) }])
        }
        return completed('ok-from-b')
      }
    }
    const chain = [a, b]
    const res = await loop({
      limits: { rounds: { soft: 10, hard: 12 } },
      models: chain,
      system: 'sys',
      prompt: 'q',
      tools: TOOLS,
      toolFns: makeToolFns()
    })
    expect(res.output).toBe('ok-from-b')
    expect(chain.length).toBe(1)
    expect(chain[0].id).toBe('b')
    // The first turn's computeBudget was called against A (head before
    // the fallback). The SECOND turn — after recovery shifted the chain —
    // must have called computeBudget against B.
    expect(bInfoCalls.length).toBeGreaterThan(0)
  })
})
