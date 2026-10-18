import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { annotateTurn, applyEvent, createLive, liveOf, renderLive } from '../src/library/live.js'
import { describeCall } from '../src/core/call-table.js'
import { readEvents } from '../src/core/spore-dir.js'
import { native } from '../src/native.js'

const BRAVE = [{ name: 'brave/1', tools: ['exec', 'wsexec'], program: '^"?\\$SPORE_BRAVE"?\\s*(.*)$', title: 'searching the web', category: 'search', detail: 'search $1' }]
const written = (name, args, callId) => ({ event: 'tool_start', name, args, callId })
const start = (name, args, callId = 'c1') => ({ ...written(name, args, callId), ...describeCall(name, args, BRAVE) })
const end = (callId, over = {}) => ({ event: 'tool_end', callId, durationMs: 10, error: false, outcome: 'ok', ...over })
const said = (text) => ({ event: 'stream', kind: 'message', delta: text })

const STARTED = '2026-10-17T10:00:00.000Z'
const at = (ms) => Date.parse(STARTED) + ms

const shown = (events, options = {}) => renderLive(liveOf(events, { startedAt: STARTED }), { now: at(0), ...options })

describe('the default rendering of a running turn', () => {
  it('says what kind of call runs, and never what it was given', () => {
    const live = createLive({ startedAt: STARTED })
    const seen = []
    for (const event of [
      start('read', { path: 'data/secret-client.pdf' }, 'a'),
      start('exec', { command: 'grep -r secret /etc' }, 'b'),
      start('wsexec', { command: 'node "$SPORE_SOURCE" forgejo --path api/v1/repos/acme/x --out data/x.json' }, 'c'),
      start('exec', { command: '"$SPORE_BRAVE" acme merger rumours', out: 'data/s.txt' }, 'd')
    ]) {
      applyEvent(live, event)
      seen.push(renderLive(live, { now: at(0) }))
    }
    expect(seen.map(lines => lines.at(-1))).toEqual(['· reading a file', '· running a command', '· asking forgejo', '· searching the web'])
    expect(seen.at(-1)[0]).toBe('working… · 4 calls')
    expect(seen.flat().join('\n')).not.toMatch(/secret|acme|etc|api/)
  })

  it('shows a conversation that asked for details the command or the path, spore\'s programs by name', () => {
    expect(shown([start('read', { path: 'data/report.md' })], { level: 'details' }).at(-1)).toBe('· reading data/report.md')
    expect(shown([start('wsexec', { command: 'node "$SPORE_SOURCE" forgejo --path api/v1/repos/acme/x/issues --out data/x.json' })], { level: 'details' }).at(-1))
      .toBe('· source forgejo --path api/v1/repos/acme/x/issues --out data/x.json')
    expect(shown([start('exec', { command: 'git log --oneline -5\ngit status' })], { level: 'details' }).at(-1)).toBe('· running git log --oneline -5')
  })

  it('shows what the turn wrote of a call, and describes one written before its spore was upgraded from the runtime\'s rows', () => {
    const told = { ...written('read', { path: 'data/c.pdf' }, 'a'), title: 'reading the contract', category: 'read', detail: 'reading data/c.pdf' }
    expect(shown([told]).at(-1)).toBe('· reading the contract')
    expect(shown([told], { level: 'details' }).at(-1)).toBe('· reading data/c.pdf')
    expect(shown([written('exec', { command: 'node "$SPORE_SOURCE" ledger --month 9' }, 'b')]).at(-1)).toBe('· asking ledger')
    expect(shown([written('exec', { command: '"$SPORE_BRAVE" acme' }, 'c')]).at(-1)).toBe('· running a command')
  })

  it('says how the current call ended when it was slow, said no or failed — except to a brief conversation', () => {
    const ran = (over) => [start('exec', { command: 'x' }, 'a'), end('a', over)]
    expect(shown(ran({ durationMs: 14_200 })).at(-1)).toBe('· running a command — 14 s')
    expect(shown(ran({ outcome: 'exit', exit: 1, error: true })).at(-1)).toBe('· running a command — exit 1')
    expect(shown(ran({ outcome: 'killed', killed: 'idle', error: true })).at(-1)).toBe('· running a command — failed')
    expect(shown([start('exec', { command: 'x' }, 'a'), { event: 'tool_end', callId: 'a', durationMs: 10, error: true }]).at(-1)).toBe('· running a command — failed')
    expect(shown(ran({ outcome: 'exit', exit: 1, error: true }), { level: 'brief' }).at(-1)).toBe('· running a command')
    expect(shown([start('exec', { command: 'x' }, 'a')]).at(-1)).toBe('· running a command')
  })

  it('counts neither a question nor a quiet ending as a call, and shows nothing of an event it has no use for', () => {
    expect(shown([{ event: 'round', index: 3 }, start('quiet', { because: 'x' }), { event: 'complete', output: null, stopReason: 'quiet' }])).toEqual(['working…'])
    expect(shown([{ event: 'round', index: 0 }, said('the answer'), { event: 'complete', output: 'the answer' }])).toEqual(['working…'])
    expect(shown([start('read', { path: 'a' }, 'a'), start('ask', { question: 'which?' }, 'b')])).toEqual(['working… · 1 call', '· reading a file'])
    expect(liveOf([], { startedAt: STARTED })).toBe(null)
  })

  it('heads it with what the model wrote before a call, as one line cut short, and never with the answer', () => {
    expect(shown([said('Found the contract.\n\nReading the fees '), said('section next.'), start('read', { path: 'c.pdf' })]))
      .toEqual(['working… · 1 call', 'Found the contract. Reading the fees section next.', '· reading a file'])
    expect(shown([start('read', { path: 'c.pdf' }), said('The fee is 3 %.')])).toEqual(['working… · 1 call', '· reading a file'])
    const long = shown([said(`${'word '.repeat(80)}`), start('read', { path: 'c.pdf' })])[1]
    expect(long.length).toBeLessThanOrEqual(200)
    expect(long.endsWith('word…')).toBe(true)
    expect(shown([said('one\u0007two\u001b[31m'), start('read', { path: 'c.pdf' })])[1]).toBe('one two [31m')
  })

  it('heads it with what the model wrote for the person, else the last paragraph of its reasoning summary, never its raw reasoning', () => {
    const stream = (kind, delta) => ({ event: 'stream', kind, delta })
    const round = (index) => ({ event: 'round', index })
    expect(shown([round(0), stream('reasoning', 'raw thought'), stream('reasoning_summary', '**Dates**\n\nCounting back 90 days '), stream('reasoning_summary', 'from 31 March.')])[1])
      .toBe('Counting back 90 days from 31 March.')
    expect(shown([round(0), stream('reasoning_summary', 'Counting back.'), stream('commentary', 'Reading the lease first.'), stream('reasoning_summary', 'More.')])[1])
      .toBe('Reading the lease first.')
    expect(shown([round(0), stream('reasoning_summary', 'Counting back.'), said('I will read it.'), start('read', { path: 'a' })])[1])
      .toBe('Counting back.')
    expect(shown([round(0), stream('commentary', 'Reading the lease.'), start('read', { path: 'a' }), round(1), stream('reasoning_summary', 'Now the notice.')])[1])
      .toBe('Now the notice.')
    expect(shown([round(0), stream('reasoning', 'raw thought')])).toEqual(['working…'])
  })

  it('says for how long once a minute has passed, and never a bound', () => {
    const events = [start('read', { path: 'a' }, 'a'), start('read', { path: 'b' }, 'b')]
    expect(shown(events, { now: at(45_000) })[0]).toBe('working… · 2 calls')
    expect(shown(events, { now: at(3 * 60_000 + 10_000) })[0]).toBe('working… · 2 calls · 3m')
    expect(renderLive(liveOf(events, { startedAt: null }), { now: at(600_000) })[0]).toBe('working… · 2 calls')
  })

  it('says why it is wrapping up, the reason to all but a brief conversation, until the limit is raised', () => {
    const wrapped = [start('read', { path: 'a' }), { event: 'wrap', dimension: 'cost' }]
    expect(shown(wrapped).at(-1)).toBe('wrapping up — reached its cost limit')
    expect(shown(wrapped, { level: 'brief' }).at(-1)).toBe('wrapping up')
    expect(shown([...wrapped, { event: 'unwrap', dimension: 'cost', soft: 2, hard: 3 }]).at(-1)).toBe('· reading a file')
  })

  it('says a message was heard until the turn makes its next call', () => {
    const heard = [start('read', { path: 'a' }, 'a'), { event: 'interject', round: 2 }]
    expect(shown(heard).at(-1)).toBe('heard you')
    expect(shown([...heard, start('read', { path: 'b' }, 'b')]).at(-1)).toBe('· reading a file')
  })
})

describe('a line of the embedder\'s own', () => {
  const WS = resolve(dirname(fileURLToPath(import.meta.url)), '.live-workspace')

  beforeEach(() => {
    rmSync(WS, { recursive: true, force: true })
    mkdirSync(WS, { recursive: true })
  })

  afterEach(() => {
    rmSync(WS, { recursive: true, force: true })
  })

  it('shows under the header at every level, until it is taken away', () => {
    const annotated = [start('read', { path: 'a' }), { event: 'annotation', text: 'usually 30 s –\n2 min' }]
    for (const level of ['brief', 'plain', 'details']) expect(shown(annotated, { level })[1]).toBe('usually 30 s – 2 min')
    expect(shown([...annotated, { event: 'annotation', text: null }])).toEqual(shown([start('read', { path: 'a' })]))
  })

  it('is written to the running turn alone, and only as a line', () => {
    expect(annotateTurn(WS, 'usually 2 min')).toEqual({ refused: 'idle' })
    native.beginTurn(WS)
    expect(annotateTurn(WS, 'usually 2 min').seq).toBeGreaterThan(0)
    expect(liveOf(readEvents(WS)).annotation).toBe('usually 2 min')
    annotateTurn(WS, null)
    expect(liveOf(readEvents(WS)).annotation).toBe(null)
    for (const line of ['', '  ', 'x'.repeat(201), 3, undefined]) {
      expect(() => annotateTurn(WS, line)).toThrow(expect.objectContaining({ type: 'ANNOTATION_INVALID' }))
    }
  })
})
