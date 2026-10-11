import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'

import { parseCommand } from '../tui/commands.js'
import { changeOf, counts, hunks, lineDiff } from '../tui/diff.js'
import { applyEvent, createLive, history, originOf } from '../tui/conversation.js'
import { limitsText, matching, priceText, spendText, sporeLabel, stateText, statusParts } from '../tui/status.js'
import { PromptEditor } from '../tui/prompt.js'
import { Answer } from '../tui/answer.js'

const turn = (turnNo, inboxFrom, inboxTo, extra = {}) => ({
  turnNo,
  inboxFrom,
  inboxTo,
  stopReason: 'answer',
  rounds: 2,
  treeUsd: 0.01,
  startedAt: '2026-10-07T10:00:00.000Z',
  endedAt: '2026-10-07T10:00:30.000Z',
  output: `answer ${turnNo}`,
  ...extra
})
const said = (inboxNo, text, extra = {}) => ({ inboxNo, text, at: '2026-10-07T10:00:00.000Z', consumed: true, ...extra })

describe('history', () => {
  it('puts what each turn read before its answer, then what no turn has read', () => {
    const items = history({
      turns: [turn(1, 0, 2), turn(2, 2, 3)],
      inbox: [said(1, 'one', { replyTo: 'terminal' }), said(2, 'two'), said(3, 'three'), said(4, 'four', { consumed: false })]
    })
    expect(items.map(i => i.kind === 'said' ? `said ${i.text}` : i.kind === 'answer' ? i.text : `end ${i.turnNo}`)).toEqual([
      'said one', 'said two', 'answer 1', 'end 1', 'said three', 'answer 2', 'end 2', 'said four'
    ])
    expect(items.at(-1).waiting).toBe(true)
    expect(items[0].origin).toBe('terminal')
    expect(items[3].durationMs).toBe(30_000)
  })

  it('shows no answer for a turn that ended without one', () => {
    const items = history({ turns: [turn(1, 0, 1, { output: null, stopReason: 'hard:cost' })], inbox: [said(1, 'go')] })
    expect(items.map(i => i.kind)).toEqual(['said', 'end'])
    expect(items[1].stopReason).toBe('hard:cost')
  })

  it('carries why a turn that could not start failed', () => {
    const items = history({ turns: [turn(1, 0, 1, { output: null, stopReason: 'error', error: 'START_FAILED', detail: 'writes here=/x, which overlaps the runtime at /x/packages/spore' })], inbox: [said(1, 'go')] })
    expect(items[1]).toMatchObject({ error: 'START_FAILED', detail: 'writes here=/x, which overlaps the runtime at /x/packages/spore' })
  })

  it('names attachments and strips what a terminal would act on', () => {
    const [item] = history({ turns: [], inbox: [said(1, 'see\x1b[2J', { consumed: false, files: [{ name: 'a.pdf' }] })] })
    expect(item.text).toBe('see[2J [a.pdf]')
  })
})

describe('originOf', () => {
  it('says where a message came from', () => {
    expect(originOf({ schedule: 'daily' })).toBe('schedule "daily"')
    expect(originOf({ hook: 'gh' })).toBe('webhook "gh"')
    expect(originOf({ job: 'crawl' })).toBe('job "crawl"')
    expect(originOf({ replyTo: 'discord:ops/123' })).toBe('discord')
    expect(originOf({})).toBe('elsewhere')
  })
})

describe('applyEvent', () => {
  it('turns text before a tool call into a note, and keeps the last text as the answer', () => {
    const live = createLive()
    applyEvent(live, { event: 'round', index: 0 })
    applyEvent(live, { event: 'stream', kind: 'message', delta: 'let me look' })
    applyEvent(live, { event: 'tool_start', name: 'read', callId: 'c1', args: { path: 'a' } })
    applyEvent(live, { event: 'tool_end', name: 'read', callId: 'c1', durationMs: 12 })
    applyEvent(live, { event: 'round', index: 1 })
    applyEvent(live, { event: 'stream', kind: 'message', delta: 'done' })
    expect(live.rounds).toBe(2)
    expect(live.notes).toEqual([{ kind: 'thought', text: 'let me look' }])
    expect(live.tools).toEqual([{ callId: 'c1', name: 'read', args: { path: 'a' }, done: true, durationMs: 12, error: false }])
    expect(live.text).toBe('done')
  })

  it('ignores reasoning and what it does not show', () => {
    const live = createLive()
    expect(applyEvent(live, { event: 'stream', kind: 'reasoning', delta: 'hm' })).toBe(false)
    expect(applyEvent(live, { event: 'heartbeat' })).toBe(false)
    expect(applyEvent(live, { event: 'tool_end', callId: 'unknown' })).toBe(false)
    expect(live).toEqual(createLive())
  })

  it('adds up what each model call cost, and keeps the last call\'s input', () => {
    const live = createLive()
    applyEvent(live, { event: 'usage', input: 1000, cost: 0.001 })
    applyEvent(live, { event: 'usage', input: 1500, cost: 0.002 })
    expect(live.input).toBe(1500)
    expect(live.cost).toBeCloseTo(0.003)
  })

  it('takes the complete event as the answer', () => {
    const live = createLive()
    applyEvent(live, { event: 'stream', kind: 'message', delta: 'partial' })
    applyEvent(live, { event: 'complete', output: 'whole', stopReason: 'answer' })
    expect(live.text).toBe('whole')
    expect(live.complete).toEqual({ stopReason: 'answer', output: 'whole' })
  })
})

describe('status', () => {
  const now = Date.parse('2026-10-07T10:01:00.000Z')
  const shown = {
    ws: '/home/u/spores/triage',
    model: 'anthropic/claude-sonnet-5-5',
    state: 'running',
    startedAt: '2026-10-07T10:00:00.000Z',
    treeUsd: 0.1234,
    billing: { kind: 'metered' },
    turnLimits: { startedAt: '2026-10-07T10:00:00.000Z', limits: { rounds: { soft: 40, hard: 45 }, cost: { soft: 0.5, hard: 0.75 } } }
  }

  it('reads the state', () => {
    const walled = { ...shown, turnLimits: { ...shown.turnLimits, limits: { ...shown.turnLimits.limits, wall: { soft: 600_000, hard: 720_000 } } } }
    expect(stateText(walled, { paused: false, now })).toBe('running')
    expect(stateText(shown, { paused: false, now })).toBe('running 1m')
    expect(stateText(shown, { paused: true, now })).toBe('paused')
    expect(stateText({ ...shown, draining: true }, { paused: false, now })).toBe('finishing')
    expect(stateText({ ...shown, state: 'idle' }, { paused: false, now })).toBe('idle')
  })

  it('reads each limit against its soft bound, and its hard one once past it', () => {
    expect(limitsText(shown.turnLimits, { rounds: 3, cost: 0.0042, now })).toBe('round 3/40 · ≈$0.0042/$0.50')
    expect(limitsText(shown.turnLimits, { rounds: 41, cost: 0.6, now })).toBe('round 41/45 · ≈$0.6000/$0.75')
    expect(limitsText({ startedAt: shown.startedAt, limits: { wall: { soft: 600_000, hard: 720_000 } } }, { rounds: 1, cost: 0, now })).toBe('1m/10m')
  })

  it('says a subscription is not metered', () => {
    expect(spendText(shown)).toBe('$0.1234')
    expect(spendText({ ...shown, billing: { kind: 'subscription', label: 'ChatGPT' } })).toBe('not metered · ChatGPT')
  })

  it('names the spore by its directory, with its state', () => {
    expect(sporeLabel({ shown, paused: false, now })).toBe('triage · running 1m')
    expect(sporeLabel({ shown, paused: true, now })).toBe('triage · paused')
  })

  it('says who else answered, the model last', () => {
    const parts = statusParts({ shown, live: { ...createLive(), rounds: 3, input: 12345, cost: 0.0042 }, attention: [{ name: 'ledger', asked: true }], now })
    expect(parts).toEqual(['ledger asked — Ctrl+P', 'round 3/40 · ≈$0.0042/$0.50', '12.3k in', 'anthropic/claude-sonnet-5-5'])
  })

  it('shows the spore\'s spend between turns', () => {
    const parts = statusParts({ shown: { ...shown, state: 'idle', turnLimits: null }, live: createLive(), attention: [], now })
    expect(parts).toEqual(['$0.1234', 'anthropic/claude-sonnet-5-5'])
  })
})

describe('priceText', () => {
  it('reads a listing\'s prices per million tokens, rounding float noise, and says when there are none', () => {
    expect(priceText({ inputPrice: 0.15000000000000002, outputPrice: 0.6 })).toBe('$0.15 in · $0.6 out per million tokens')
    expect(priceText({ inputPrice: 0, outputPrice: 0 })).toBe('$0 in · $0 out per million tokens')
    expect(priceText({ inputPrice: null, outputPrice: null })).toBe('no prices')
  })
})

describe('matching', () => {
  const items = [
    { value: 'anthropic/claude-sonnet-4.5', label: 'anthropic/claude-sonnet-4.5', description: '$3 in · $15 out per million tokens' },
    { value: 'mistralai/ministral-8b-2512', label: 'mistralai/ministral-8b-2512', description: 'no prices' }
  ]

  it('finds every word anywhere, in the id or the description, and keeps all for nothing typed', () => {
    expect(matching(items, 'claude').map(item => item.value)).toEqual(['anthropic/claude-sonnet-4.5'])
    expect(matching(items, '8b mistral').map(item => item.value)).toEqual(['mistralai/ministral-8b-2512'])
    expect(matching(items, 'no prices').map(item => item.value)).toEqual(['mistralai/ministral-8b-2512'])
    expect(matching(items, '  ')).toHaveLength(2)
    expect(matching(items, 'gemini')).toEqual([])
  })
})

describe('parseCommand', () => {
  it('reads a command and its arguments', () => {
    expect(parseCommand('/extend wall 30m')).toEqual({ name: 'extend', args: ['wall', '30m'] })
    expect(parseCommand('  /STOP ')).toEqual({ name: 'stop', args: [] })
  })

  it('leaves a message alone', () => {
    expect(parseCommand('hello')).toBe(null)
    expect(parseCommand('//etc/hosts is odd')).toBe(null)
    expect(parseCommand('/')).toBe(null)
  })

  it('leaves a path alone, as a dropped file arrives', () => {
    expect(parseCommand('/home/clb/Pictures/Screenshots/Screenshot From 2026-10-10 08-09-21.png what is this?')).toBe(null)
    expect(parseCommand('/tmp/notes.txt')).toBe(null)
  })
})

describe('what an edit or a write changes', () => {
  const ops = (diff) => diff.map(line => `${line.op}${line.text}`)

  it('keeps what is common and marks what went and what came', () => {
    expect(ops(lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n'))).toEqual([' a', '-b', '+B', ' c', '+d'])
    expect(ops(lineDiff('', 'new\n'))).toEqual(['+new'])
    expect(ops(lineDiff('same', 'same'))).toEqual([' same'])
  })

  it('shows a change too large to align as removed then added, which is still true', () => {
    const before = Array.from({ length: 600 }, (_, i) => `b${i}`).join('\n')
    const after = Array.from({ length: 600 }, (_, i) => `a${i}`).join('\n')
    const diff = lineDiff(before, after)
    expect(counts(diff)).toEqual({ added: 600, removed: 600 })
    expect(diff[0].op).toBe('-')
    expect(diff.at(-1).op).toBe('+')
  })

  it('keeps two lines around each change and folds the rest', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')
    const after = before.replace('l10', 'L10')
    expect(ops(hunks(lineDiff(before, after)))).toEqual(['…', ' l8', ' l9', '-l10', '+L10', ' l11', ' l12', '…'])
  })

  it('reads an edit as its old and new text, a write as the whole file, and nothing else', () => {
    expect(changeOf({ name: 'edit', args: { path: 'here/a.js', old: 'x = 1', new: 'x = 2' } })).toMatchObject({ path: 'here/a.js', whole: false, diff: [{ op: '-', text: 'x = 1' }, { op: '+', text: 'x = 2' }] })
    expect(changeOf({ name: 'write', args: { path: 'here/b.js', content: 'one\ntwo\n' } })).toMatchObject({ whole: true, diff: [{ op: '+', text: 'one' }, { op: '+', text: 'two' }] })
    expect(changeOf({ name: 'exec', args: { command: 'ls' } })).toBe(null)
  })
})

describe('the line you type on', () => {
  const typed = (text) => {
    const editor = new PromptEditor({ terminal: { rows: 24 }, requestRender () {} }, { borderColor: (line) => line, selectList: {} })
    editor.setText(text)
    return editor.render(20)
  }

  it('starts with > and is as wide as the screen, borders included', () => {
    const lines = typed('hello')
    expect(lines[1].startsWith('> hello')).toBe(true)
    for (const line of lines) expect(visibleWidth(line)).toBe(20)
  })

  it('names the spore at the right of its bottom border, and drops it when there is no room', () => {
    const editor = new PromptEditor({ terminal: { rows: 24 }, requestRender () {} }, { borderColor: (line) => line, selectList: {} })
    editor.label = 'triage · idle'
    expect(editor.render(30).at(-1)).toBe(`${'─'.repeat(14)} triage · idle ─`)
    for (const line of editor.render(30)) expect(visibleWidth(line)).toBe(30)
    expect(editor.render(18).at(-1)).toBe('─'.repeat(18))
  })

  it('wraps under the text, not under the >', () => {
    const lines = typed('a'.repeat(30))
    expect(lines[1].startsWith('> a')).toBe(true)
    expect(lines[2].startsWith('  a')).toBe(true)
  })
})

describe('the code blocks of an answer', () => {
  const same = (text) => text
  const theme = Object.fromEntries(['heading', 'link', 'linkUrl', 'code', 'codeBlock', 'codeBlockBorder', 'quote', 'quoteBorder', 'hr', 'listBullet', 'bold', 'italic', 'strikethrough', 'underline'].map(key => [key, same]))
  const long = `az account show --query '${'x'.repeat(150)}' --output yaml`
  const text = `Run:\n\n\`\`\`sh\n${long}\n\`\`\`\n\n- then this one:\n\n  \`\`\`sh\n  az account list --output table\n  \`\`\`\n`

  it('are kept as written, a line wider than the screen and a block inside a list included', () => {
    const answer = new Answer(text, theme)
    answer.render(60)
    expect(answer.blocks).toEqual([{ lang: 'sh', text: long }, { lang: 'sh', text: 'az account list --output table' }])
  })

  it('are numbered on their opening fence when the answer is labelled, and only then', () => {
    const answer = new Answer(text, theme, { labelled: true })
    const lines = answer.render(200).map(line => line.trim())
    expect(lines).toContain('```sh · /copy 1')
    expect(lines).toContain('```sh · /copy 2')
    expect(lines.filter(line => line === '```')).toHaveLength(2)
    answer.label(false)
    expect(answer.render(200).some(line => line.includes('/copy'))).toBe(false)
  })

  it('are counted once however often the answer is drawn', () => {
    const answer = new Answer(text, theme)
    answer.render(60)
    answer.render(60)
    answer.render(90)
    expect(answer.blocks).toHaveLength(2)
  })
})
