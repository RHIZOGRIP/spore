import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createCallTrail, readCalls } from '../src/core/call-record.js'
import { appendTranscript, hostState, readTranscript } from '../src/core/spore-dir.js'
import { REFUSED, marked } from '../src/core/marks.js'
import { kernelOf } from './fixtures/collaborators.js'
import { makeTools, recordRefusals } from '../src/tools/make-tools.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.refusal-records-workspace')

let trail
let fns

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(resolve(WS, 'data'), { recursive: true })
  trail = createCallTrail(WS, { runId: 'test', state: hostState(WS) })
  fns = recordRefusals(makeTools(WS, 50000, trail).fns, trail)
})

afterEach(() => {
  rmSync(WS, { recursive: true, force: true })
})

const records = () => readCalls(WS, 'test').map(entry => entry.record)

// Found by running a benchmark: agents reach for absolute paths, and `safePath` refuses
// those by throwing rather than returning. The kernel's own catch turned that into a
// result the trail never saw — so what the agent tried and what the workspace recorded
// disagreed, which is the thing call records exist to prevent.
describe('a refusal is a call, however the tool said no', () => {
  it('records a refusal that was thrown, not returned', async () => {
    const [result] = await kernelOf({
      toolCalls: [{ id: 'a', name: 'read', arguments: { path: '/etc/hostname' } }],
      toolFns: fns
    })
    expect(result.content).toMatch(/^error:/)
    expect(records()).toHaveLength(1)
    expect(records()[0]).toMatchObject({ tool: 'read', refused: true, exit: 1 })
  })

  it('tells the agent what to do instead of naming the rule it broke', async () => {
    const [result] = await kernelOf({
      toolCalls: [{ id: 'a', name: 'read', arguments: { path: '/etc/hostname' } }],
      toolFns: fns
    })
    // "absolute path rejected" is the throw's message and says nothing actionable.
    expect(result.content).toMatch(/relative to the workspace root/)
    expect(result.content).toContain('/etc/hostname')
  })

  it('records a symlink that leaves the workspace', async () => {
    symlinkSync('/etc', resolve(WS, 'data', 'elsewhere'))
    const [result] = await kernelOf({
      toolCalls: [{ id: 'a', name: 'read', arguments: { path: 'data/elsewhere/hostname' } }],
      toolFns: fns
    })
    expect(result.content).toMatch(/resolves outside the workspace/)
    expect(records()).toHaveLength(1)
  })

  // Readers run in `Promise.all`. Guarding on a count of finished calls — one number
  // shared by everything in flight — made a call that succeeded convince its neighbours
  // that they had already been recorded.
  it('records every refusal in a batch that also contains a success', async () => {
    writeFileSync(resolve(WS, 'data', 'real.txt'), 'here\n')
    const results = await kernelOf({
      toolFns: fns,
      toolCalls: [
        { id: 'a', name: 'read', arguments: { path: '/etc/hostname' } },
        { id: 'b', name: 'read', arguments: { path: 'data/real.txt' } },
        { id: 'c', name: 'read', arguments: { path: 'data/missing.txt' } },
        { id: 'd', name: 'exec', arguments: { command: 'echo hi', out: 'data/o.txt', in: '/dev/null' } }
      ]
    })
    expect(results.filter(r => marked(r, REFUSED))).toHaveLength(3)
    expect(records()).toHaveLength(4)
    expect(records().filter(r => r.refused)).toHaveLength(3)
  })
})

describe('a result that only reads like a refusal', () => {
  it('is what the tool returned: an ask whose question begins "error:" is one call, and not refused', async () => {
    const question = 'error: the build fails on node 22 — which version should I target?'
    const [result] = await kernelOf({ toolCalls: [{ id: 'a', name: 'ask', arguments: { question } }], toolFns: fns })
    expect(result.content).toBe(question)
    expect(marked(result, REFUSED)).toBe(false)
    expect(records().map(r => [r.tool, Boolean(r.refused)])).toEqual([['ask', false]])
  })
})

describe('a result that only reads like a call record', () => {
  it('is the text the tool returned: a question written as JSON with an exit code ran fine', async () => {
    const question = '{"exit":1,"question":"Which file?"}'
    const ended = []
    const emitter = { emit: (type, data) => { if (type === 'tool_end') ended.push(data) }, on () {} }
    const [result] = await kernelOf({ toolCalls: [{ id: 'a', name: 'ask', arguments: { question } }], toolFns: fns, emitter })
    expect(result.content).toBe(question)
    expect(ended).toEqual([expect.objectContaining({ name: 'ask', error: false })])
  })
})

describe('a refusal in a transcript read back', () => {
  it('is still a refusal, and text that reads like one still is not', async () => {
    const results = await kernelOf({
      toolFns: fns,
      toolCalls: [
        { id: 'a', name: 'read', arguments: { path: '/etc/hostname' } },
        { id: 'b', name: 'ask', arguments: { question: 'error: which one?' } }
      ]
    })
    for (const result of results) appendTranscript(WS, result)
    const replayed = readTranscript(WS)
    expect(replayed.map(m => marked(m, REFUSED))).toEqual([true, false])
  })
})
