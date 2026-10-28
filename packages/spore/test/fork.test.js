/**
 * `spore fork`, run as it actually runs: the real binaries, the broker, Landlock — only the
 * model's replies are scripted. A turn of two calls is cut after the first, and the fork
 * has to pick up exactly there.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { startGate } from './fixtures/model-server.js'
import { acquireLock, copyInbox, readState, readTranscript, releaseLock, readTranscriptEntries, readTurns, hostState, writeOutcome, writeTranscriptEntries, writeTurnRecords } from '../src/core/spore-dir.js'
import { callRuns, readCall, readCalls, writeCall } from '../src/core/call-record.js'
import { forkWorkspace, readFork } from '../src/core/fork.js'
import { definitionWith } from '../src/testing.js'
import { outsideRoot, outsideWorkspace } from './fixtures/outside-ws.js'
import { answers, calls, scriptedMo } from './fixtures/scripted-model.js'

const run = promisify(execFile)
const SPORE = resolve(dirname(fileURLToPath(import.meta.url)), '../../spore-cli/bin/spore.js')

let root
let original
let gate
let mo

const serve = async (reply) => {
  await gate?.close()
  mo = scriptedMo(reply)
  gate = await startGate({ mo, name: 'fork-test' })
}

const spore = async (...args) => {
  try {
    const { stdout, stderr } = await run(process.execPath, [SPORE, ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
    })
    return { code: 0, stdout, stderr }
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr }
  }
}

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const roundsOf = (ws, runId) => readState(ws, [], db => db.prepare('SELECT callNo, round FROM calls WHERE runId = ? ORDER BY callNo').all(runId))
  .map(({ callNo, round }) => [callNo, round])

beforeAll(async () => {
  root = outsideRoot('fork')
  original = outsideWorkspace('fork-original')
  // Round 0 writes a file, round 1 writes another, round 2 answers. The pauses put clear
  // time between the rounds, so the islands' birth times fall on the right side of the cut.
  await serve(async (input, round) => {
    await pause(40)
    if (round === 0) return calls('wsexec', { command: 'echo one > data/a.txt', out: 'data/log-a.txt' })
    if (round === 1) return calls('wsexec', { command: 'echo two > data/b.txt', out: 'data/log-b.txt' })
    return answers('first answer')
  })
  const first = await spore('send', original, 'write two files')
  expect(first.code, first.stderr).toBe(0)
})

afterAll(async () => {
  await gate?.close()
  rmSync(root, { recursive: true, force: true })
  rmSync(original, { recursive: true, force: true })
})

describe('spore fork', () => {
  it('starts from a turn whose calls are each written down with the round that made them', () => {
    const [runId] = readTurns(original).map(t => t.runId)
    expect(roundsOf(original, runId)).toEqual([[1, 1], [2, 2]])
    expect(readCall(original, runId, '0002').round).toBe(2)
  })

  it('carries the turn on from the cut, in the same run, with its rounds still counted', async () => {
    const into = join(root, 'carried')
    await serve(async (input, round) => round === 0
      ? calls('wsexec', { command: 'echo three > data/c.txt', out: 'data/log-c.txt' })
      : answers('forked answer'))

    const forked = await spore('fork', original, '--at', '0001', into)
    expect(forked.code, forked.stderr).toBe(0)
    expect(forked.stdout.trim()).toBe('forked answer')

    // What the model was shown first: the history up to call 0001's result, and nothing new.
    const firstInput = mo.seen[0]
    expect(firstInput.at(-1).role).toBe('tool')
    expect(firstInput.filter(m => m.role === 'user')).toHaveLength(1)

    const [runId] = readTurns(original).map(t => t.runId)
    const turns = readTurns(into)
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ runId, concluded: true, rounds: 3 })
    expect(readCall(into, runId, '0001')).not.toBe(null)
    expect(readCall(into, runId, '0002').command).toMatch(/echo three/)
    expect(roundsOf(into, runId)).toEqual([[1, 1], [2, 2]])

    expect(readFileSync(join(into, 'data/a.txt'), 'utf8')).toBe('one\n')
    expect(existsSync(join(into, 'data/b.txt'))).toBe(false)
    expect(readFileSync(join(into, 'data/c.txt'), 'utf8')).toBe('three\n')
    expect(readTranscript(into).at(-1)).toMatchObject({ role: 'assistant', content: 'forked answer' })
    expect(readFork(into)).toMatchObject({ runId, at: `${runId}/0001`, rounds: 1 })
  })

  it('with --replay, runs the calls of the round again before carrying on', async () => {
    const into = join(root, 'replayed')
    await serve(async () => answers('replayed answer'))

    const forked = await spore('fork', original, '--at', '0002', '--replay', into)
    expect(forked.code, forked.stderr).toBe(0)

    // The model's first input already holds call 0002's result — produced by the fork, not
    // copied from the run.
    const firstInput = mo.seen[0]
    expect(firstInput.at(-1).role).toBe('tool')
    const [runId] = readTurns(original).map(t => t.runId)
    const replayed = readCall(into, runId, '0002')
    expect(replayed.command).toMatch(/echo two/)
    expect(Date.parse(replayed.startedAt)).toBeGreaterThan(Date.parse(readFork(into).cutAt))
    expect(readFileSync(join(into, 'data/b.txt'), 'utf8')).toBe('two\n')
    expect(roundsOf(into, runId)).toEqual([[1, 1], [2, 2]])
    expect(readTurns(into)[0]).toMatchObject({ runId, rounds: 3, concluded: true })
    expect(readFork(into)).toMatchObject({ replay: true, rounds: 2 })
  })

  it('runs under another definition when given one', () => {
    const definition = join(root, 'other.cmk')
    writeFileSync(definition, definitionWith('anthropic/claude-haiku-4-5').replace(/\n---\n[\s\S]*$/, '\n---\n\nYou are the other one.\n'))
    const made = forkWorkspace({ run: original, at: '0001', into: join(root, 'other'), definition })
    expect(readFileSync(join(made.ws, 'spore.cmk'), 'utf8')).toMatch(/You are the other one/)
  })

  it('refuses a definition that does not parse', () => {
    const definition = join(root, 'broken.cmk')
    writeFileSync(definition, '---\nname: broken\n---\n')
    expect(() => forkWorkspace({ run: original, at: '0001', into: join(root, 'broken'), definition })).toThrow(/broken\.cmk/)
    expect(existsSync(join(root, 'broken'))).toBe(false)
  })

  it('refuses a cut that a later change would make inexact, and leaves nothing behind', () => {
    const a = join(original, 'data/a.txt')
    const before = readFileSync(a, 'utf8')
    const { atime, mtime } = statSync(a)
    appendFileSync(a, 'changed later\n')
    try {
      expect(() => forkWorkspace({ run: original, at: '0001', into: join(root, 'inexact') })).toThrow(/data\/a\.txt was changed after/)
      expect(existsSync(join(root, 'inexact'))).toBe(false)
    } finally {
      writeFileSync(a, before)
      utimesSync(a, atime, mtime)
    }
  })

  it('refuses a call that is not in the turn, a target that exists, and a run that is running', () => {
    expect(() => forkWorkspace({ run: original, at: '0009', into: join(root, 'nine') })).toThrow(/call 0009 is not in turn/)
    expect(() => forkWorkspace({ run: original, at: '0001', into: root })).toThrow(/already exists/)
    acquireLock(original)
    try {
      expect(() => forkWorkspace({ run: original, at: '0001', into: join(root, 'busy') })).toThrow(/is running/)
    } finally {
      releaseLock(original)
    }
  })

  // Its turn has ended and waits only on the model calls it left in flight: nothing a fork reads is
  // still changing, and the turn to cut is the one not yet written down.
  it('forks a run that is draining, at a call of the turn still pending', () => {
    const turns = readTurns(original)
    const { turnId, turnNo, inboxFrom, ownUsd, treeUsd, settled, ...last } = turns.at(-1)
    const drained = join(root, 'drained-run')
    mkdirSync(drained)
    copyFileSync(join(original, 'spore.cmk'), join(drained, 'spore.cmk'))
    writeTurnRecords(drained, turns.slice(0, -1))
    writeTranscriptEntries(drained, readTranscriptEntries(original)
      .map(({ turnId: said, ...entry }) => (said === turnId ? entry : { ...entry, turnId: said })))
    for (const runId of callRuns(original)) {
      for (const { call, record } of readCalls(original, runId)) writeCall(drained, runId, call, record)
    }
    copyInbox(original, drained, last.inboxTo)
    writeOutcome(hostState(drained), last)
    acquireLock(drained)
    try {
      const made = forkWorkspace({ run: drained, at: '0001', into: join(root, 'draining') })
      expect(made.runId).toBe(last.runId)
    } finally {
      releaseLock(drained)
    }
  })
})

describe('spore fork between turns', () => {
  let twice

  const said = (input) => input.filter(m => m.role === 'user').map(m => (typeof m.content === 'string' ? m.content : m.content.map(p => p.text ?? '').join('')))
  const inboxOf = (ws) => readState(ws, [], db => db.prepare('SELECT inboxNo, consumed FROM inbox ORDER BY inboxNo').all())
    .map(({ inboxNo, consumed }) => [inboxNo, Boolean(consumed)])

  // Turn 1 writes data/a.txt, turn 2 data/b.txt, each in its own run; a schedule and a sporangium
  // record are the spore's beside them.
  beforeAll(async () => {
    twice = outsideWorkspace('fork-twice')
    writeFileSync(join(twice, 'sporangium.json'), JSON.stringify({ sporangium: 'perennial' }) + '\n')
    await serve(async (input, round) => {
      await pause(40)
      return round === 0 ? calls('wsexec', { command: 'echo one > data/a.txt', out: 'data/log-a.txt' }) : answers('first answer')
    })
    const first = await spore('send', twice, 'the first')
    expect(first.code, first.stderr).toBe(0)
    await serve(async (input, round) => {
      await pause(40)
      return round === 0 ? calls('wsexec', { command: 'echo two > data/b.txt', out: 'data/log-b.txt' }) : answers('second answer')
    })
    const second = await spore('send', twice, 'the second')
    expect(second.code, second.stderr).toBe(0)
    mkdirSync(join(twice, 'schedules'))
    writeFileSync(join(twice, 'schedules/daily.cmk'), '---\nwhen: 0 7 * * *\ntz: UTC\n---\n\nThe digest.\n')
  })

  afterAll(() => rmSync(twice, { recursive: true, force: true }))

  it('copies a spore as it stands after its last turn, starting nothing and leaving its schedules behind', async () => {
    const into = join(root, 'copy')
    const forked = await spore('fork', twice, into)
    expect(forked.code, forked.stderr).toBe(0)
    expect(forked.stdout).toBe('')
    expect(forked.stderr).toBe(`spore: forked ${twice} after turn 2 into ${into} — its next message starts its first turn\n`)

    expect(readTurns(into).map(t => [t.turnNo, t.runId, t.output])).toEqual(readTurns(twice).map(t => [t.turnNo, t.runId, t.output]))
    expect(readTranscriptEntries(into)).toEqual(readTranscriptEntries(twice))
    for (const runId of callRuns(twice)) expect(readCalls(into, runId)).toEqual(readCalls(twice, runId))
    expect(inboxOf(into)).toEqual([[1, true], [2, true]])
    expect(readFileSync(join(into, 'data/a.txt'), 'utf8')).toBe('one\n')
    expect(readFileSync(join(into, 'data/b.txt'), 'utf8')).toBe('two\n')
    expect(readFileSync(join(into, 'sporangium.json'), 'utf8')).toBe(readFileSync(join(twice, 'sporangium.json'), 'utf8'))
    expect(existsSync(join(into, 'schedules/daily.cmk'))).toBe(false)
    expect(readFork(into)).toMatchObject({ from: twice, at: 'turn:2', turnNo: 2, definition: null })
  })

  it('carries the conversation on in the copy\'s first turn, and leaves the spore it was cut from as it was', async () => {
    await serve(async () => answers('the copy answers'))
    const sent = await spore('send', join(root, 'copy'), 'the third')
    expect(sent.code, sent.stderr).toBe(0)
    expect(sent.stdout.trim()).toBe('the copy answers')
    const told = said(mo.seen[0])
    expect(told).toHaveLength(3)
    expect(told[0]).toMatch(/the first$/)
    expect(told[1]).toMatch(/the second$/)
    expect(told[2]).toMatch(/the third$/)
    expect(mo.seen[0].filter(m => m.role === 'assistant').map(m => m.content)).toEqual(expect.arrayContaining(['first answer', 'second answer']))
    expect(readTurns(join(root, 'copy')).map(t => t.turnNo)).toEqual([1, 2, 3])
    expect(readTurns(twice).map(t => t.turnNo)).toEqual([1, 2])
  })

  it('copies a spore as it stood after an earlier turn', () => {
    const made = forkWorkspace({ run: twice, at: 'turn:1', into: join(root, 'after-one') })
    const [one] = readTurns(twice)
    expect(readTurns(made.ws).map(t => [t.turnNo, t.runId])).toEqual([[1, one.runId]])
    expect(readTranscriptEntries(made.ws)).toEqual(readTranscriptEntries(twice).filter(entry => entry.turnId === one.turnId))
    expect(callRuns(made.ws)).toEqual([one.runId])
    expect(inboxOf(made.ws)).toEqual([[1, true]])
    expect(readFileSync(join(made.ws, 'data/a.txt'), 'utf8')).toBe('one\n')
    expect(existsSync(join(made.ws, 'data/b.txt'))).toBe(false)
    expect(made).toMatchObject({ at: 'turn:1', turnNo: 1 })
  })

  it('refuses a turn that is not there, --replay, a spore with no turn, and one running', () => {
    expect(() => forkWorkspace({ run: twice, at: 'turn:9', into: join(root, 'nine-turns') })).toThrow(/no turn 9 in/)
    expect(() => forkWorkspace({ run: twice, at: 'turn:1', into: join(root, 'replay-turn'), replay: true })).toThrow(/--replay runs a round again/)
    const fresh = outsideWorkspace('fork-fresh')
    try {
      expect(() => forkWorkspace({ run: fresh, into: join(root, 'fresh-copy') })).toThrow(/has finished no turn/)
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
    acquireLock(twice)
    try {
      expect(() => forkWorkspace({ run: twice, into: join(root, 'busy-copy') })).toThrow(/is running/)
    } finally {
      releaseLock(twice)
    }
    for (const name of ['nine-turns', 'replay-turn', 'fresh-copy', 'busy-copy']) expect(existsSync(join(root, name))).toBe(false)
  })
})
