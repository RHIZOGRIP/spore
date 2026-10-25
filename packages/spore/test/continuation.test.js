import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildContinuation } from '../src/core/continuation.js'
import { writeCall } from '../src/core/call-record.js'
import { appendTranscript, writableDirs } from '../src/core/spore-dir.js'
import { COMPACTED, WRAP, mark } from '../src/core/marks.js'
import { resolveEmptyCompletion } from '../src/core/answer-result.js'
import { silent } from '../src/observability/logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.continuation-workspace')

const call = (id, meta) => {
  mkdirSync(resolve(WS, 'calls', 'run1', id), { recursive: true })
  writeCall(WS, 'run1', id, { call: id, startedAt: '2026-09-27T00:00:00.000Z', ...meta })
}

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  for (const d of writableDirs(WS)) mkdirSync(d, { recursive: true })
})

afterEach(() => {
  rmSync(WS, { recursive: true, force: true })
})

describe('the continuation record', () => {
  it('is assembled from the record on disk, with no model call', () => {
    appendTranscript(WS, { role: 'user', content: 'count the exoplanets' })
    call('0001', { tool: 'exec', exit: 0, command: 'curl -sS https://example.test/api' })
    call('0002', { tool: 'wsexec', exit: 1, command: 'python3 parse.py' })
    writeFileSync(resolve(WS, 'data/partial.csv'), 'a,b\n1,2\n')

    const { text, path } = buildContinuation(WS, {
      stopReason: 'hard:cost',
      spent: { rounds: 45, cost: 0.7512, wall: 610000 }
    })

    expect(text).toMatch(/# Stopped: hard:cost/)
    expect(text).toMatch(/Spent 45 rounds, \$0\.7512, 610s/)
    expect(text).toMatch(/count the exoplanets/)
    expect(text).toMatch(/`exec` exit 0 — curl -sS/)
    expect(text).toMatch(/`wsexec` exit 1 — python3 parse\.py/)
    expect(text).toMatch(/`data\/partial\.csv` \(8 B\)/)
    expect(text).toMatch(/Run again in this workspace/)
    expect(path).toBe('calls/run1/continuation.md')
    expect(readFileSync(resolve(WS, path), 'utf8')).toBe(text)
  })

  it('writes into calls/, the one island still open once the root is read-only', () => {
    call('0001', { tool: 'read', path: 'data/x.txt' })
    buildContinuation(WS, { stopReason: 'hard:wall', spent: { rounds: 3, cost: 0, wall: 720000 } })
    expect(existsSync(resolve(WS, 'calls/run1/continuation.md'))).toBe(true)
  })

  // A write records the file it produced and nothing that reads like a target, so it
  // used to arrive here as `write exit 0 —`: a call happened, nothing about what it
  // touched, in the one document a parent has for deciding what to do next.
  it('names the file a write touched', () => {
    call('0001', { tool: 'write', exit: 0, files: { out: { path: 'data/report.md', bytes: 12 } } })
    const { text } = buildContinuation(WS, { stopReason: 'hard:rounds', spent: { rounds: 3, cost: 0.1, wall: 1000 } })
    expect(text).toMatch(/`write` exit 0 — data\/report\.md/)
  })

  it('names a killed call as killed rather than as an exit code', () => {
    call('0001', { tool: 'wsexec', killed: 'deadline', command: 'sleep 600' })
    const { text } = buildContinuation(WS, { stopReason: 'hard:wall', spent: { rounds: 1, cost: 0, wall: 720000 } })
    expect(text).toMatch(/`wsexec` killed:deadline — sleep 600/)
  })

  it('skips the wrap notice when reporting what was asked', () => {
    appendTranscript(WS, { role: 'user', content: 'the real question' })
    appendTranscript(WS, mark({ role: 'user', content: '[System: this turn has reached its rounds limit]' }, WRAP))
    const { text } = buildContinuation(WS, { stopReason: 'hard:rounds', spent: { rounds: 45, cost: 0, wall: 1 } })
    expect(text).toMatch(/the real question/)
    expect(text).not.toMatch(/\[System: this turn has reached/)
  })

  it('reports what the person asked, never what the runtime said after it', () => {
    appendTranscript(WS, mark({ role: 'user', content: 'a summary of the earlier turns' }, COMPACTED))
    appendTranscript(WS, { role: 'user', content: [{ type: 'text', text: 'the real question' }, { type: 'image', fileUri: 'file:///x.png', mimeType: 'image/png' }] })
    resolveEmptyCompletion({ output: '' }, { emptyState: { retries: 0 }, emit: () => {}, append: (message) => appendTranscript(WS, message), logger: silent, round: 1 })
    const { text } = buildContinuation(WS, { stopReason: 'hard:rounds', spent: { rounds: 45, cost: 0, wall: 1 } })
    expect(text).toMatch(/## Asked\n\nthe real question\n/)
    expect(text).not.toMatch(/previous response was empty/)
  })

  it('tells a cell to be respawned rather than resumed', () => {
    call('0001', { tool: 'read', path: 'in.md' })
    const { text } = buildContinuation(WS, { stopReason: 'hard:rounds', spent: { rounds: 7, cost: 0.1, wall: 1000 }, precursor: 'summarize' })
    expect(text).toMatch(/This cell is spent/)
    expect(text).toMatch(/precursors\/summarize\.cmk/)
    expect(text).not.toMatch(/transcript replays/)
  })

  it('says a discarded answer was discarded, not that none was produced', () => {
    call('0001', { tool: 'read', path: 'in.md' })
    const { text } = buildContinuation(WS, { stopReason: 'soft:rounds', spent: { rounds: 5, cost: 0.1, wall: 1000 }, precursor: 'summarize' })
    expect(text).toMatch(/its answer was discarded/)
    expect(text).not.toMatch(/No answer was produced/)
  })

  it('says what it can when a workspace has no trail at all', () => {
    rmSync(resolve(WS, 'calls'), { recursive: true, force: true })
    const { text, path } = buildContinuation(WS, { stopReason: 'hard:rounds', spent: { rounds: 45, cost: 0.1, wall: 1000 } })
    expect(text).toMatch(/# Stopped: hard:rounds/)
    expect(path).toBe(null)
  })
})
