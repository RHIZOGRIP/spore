import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { attemptOf, attempts, failingAlike, planFanout, stageAttempt } from '../src/delegation/fanout.js'
import { writeTurnRecords } from '../src/core/spore-dir.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PARTS = resolve(__dirname, '.fanout-workspace')
const STARTED = '2026-01-01T00:00:00.000Z'

const part = (name, { prompt = true, frame, turn } = {}) => {
  const ws = resolve(PARTS, name)
  mkdirSync(ws, { recursive: true })
  if (prompt) writeFileSync(resolve(ws, 'in.md'), 'material')
  if (frame) writeFileSync(resolve(ws, 'spawn.json'), JSON.stringify(frame) + '\n')
  if (turn) writeTurnRecords(ws, [turn])
  return ws
}

beforeEach(() => {
  rmSync(PARTS, { recursive: true, force: true })
  mkdirSync(PARTS, { recursive: true })
})

afterEach(() => {
  rmSync(PARTS, { recursive: true, force: true })
})

describe('what a fan-out has left to do', () => {
  it('runs a part nothing has touched', () => {
    part('a')
    const plan = planFanout(PARTS, { prompt: 'in.md' })
    expect(plan.run).toEqual([{ part: 'a', ws: resolve(PARTS, 'a'), from: null }])
    expect(plan.done).toEqual([])
  })

  // They disagree on purpose under `on-wrap: discard`: the loop answered and the
  // spawn discarded it, so there is no file to reduce.
  it('believes the spawn frame over the turn record about whether there is an answer', () => {
    part('a', { frame: { answer: null, stopReason: 'soft:rounds' }, turn: { startedAt: STARTED, concluded: true, stopReason: 'soft:rounds' } })
    const plan = planFanout(PARTS, { prompt: 'in.md' })
    expect(plan.done).toEqual([])
    expect(plan.run[0].ws).toBe(resolve(PARTS, 'a--2'))
  })

  it('takes a frame with an error as a failure, whatever the turn record says', () => {
    part('a', {
      frame: { answer: null, error: { message: 'the cell could not finish', detail: "ENOENT: no such file or directory, open 'data/audit/out.json'", type: 'SPAWN_WORKER_FAILED' } },
      turn: { startedAt: STARTED, concluded: true, stopReason: 'answer' }
    })
    const attempt = attemptOf(resolve(PARTS, 'a'))
    expect(attempt.answered).toBe(false)
    expect(attempt.failed).toMatch(/ENOENT/)
  })

  it('leaves an answered part alone, which is what makes re-running safe', () => {
    part('a', { frame: { answer: 'data/out.json', stopReason: 'answer' }, turn: { startedAt: STARTED, concluded: true, treeMicros: 40000 } })
    const plan = planFanout(PARTS, { prompt: 'in.md' })
    expect(plan.run).toEqual([])
    expect(plan.done).toMatchObject([{ part: 'a', answered: true, cost: 0.04 }])
  })

  // A workspace holding spawn.json is refused a second run, so a killed part cannot
  // simply be re-spawned. Working that out was left to the agent, and it is where a
  // cancelled fan-out stranded.
  it('retries a spent workspace in a fresh one beside it', () => {
    part('a', { frame: { answer: null, stopReason: 'cancelled', running: true } })
    const plan = planFanout(PARTS, { prompt: 'in.md' })
    expect(plan.run).toEqual([{ part: 'a', ws: resolve(PARTS, 'a--2'), from: resolve(PARTS, 'a') }])
  })

  it('counts attempts, so a second retry is --3 and not --2 again', () => {
    part('a', { frame: { answer: null, stopReason: 'hard:rounds' } })
    part('a--2', { frame: { answer: null, stopReason: 'hard:rounds' } })
    expect(planFanout(PARTS, { prompt: 'in.md' }).run[0].ws).toBe(resolve(PARTS, 'a--3'))
    expect([...attempts(PARTS).keys()]).toEqual(['a'])
  })

  it('says why it cannot retry a part whose material is gone', () => {
    part('a', { prompt: false, frame: { answer: null, stopReason: 'cancelled' } })
    const plan = planFanout(PARTS, { prompt: 'in.md' })
    expect(plan.run).toEqual([])
    expect(plan.skipped).toEqual([{ part: 'a', reason: 'no in.md to retry from' }])
  })

  it('puts the material into the fresh workspace, which has none of its own', () => {
    const from = part('a', { frame: { answer: null, stopReason: 'cancelled' } })
    const ws = stageAttempt({ ws: resolve(PARTS, 'a--2'), from }, 'in.md')
    expect(attemptOf(ws)).toBe(null)
    expect(readFileSync(resolve(ws, 'in.md'), 'utf8')).toBe('material')
  })

  // Interrupted between staging and starting, the next run should take the workspace
  // that is already there rather than number past it and leave it empty forever.
  it('reuses a retry staged by a run that never got to start it', () => {
    const from = part('a', { frame: { answer: null, stopReason: 'cancelled' } })
    stageAttempt({ ws: resolve(PARTS, 'a--2'), from }, 'in.md')
    expect(planFanout(PARTS, { prompt: 'in.md' }).run[0].ws).toBe(resolve(PARTS, 'a--2'))
  })
})

describe('stopping early', () => {
  const failed = (stopReason) => ({ started: true, answered: false, stopReason })

  it('stops when the first few fail the same way', () => {
    expect(failingAlike([failed('hard:cost'), failed('hard:cost'), failed('hard:cost')], 3)).toBe('hard:cost')
  })

  it('keeps going while the failures differ — that is work being hard, not broken', () => {
    expect(failingAlike([failed('hard:cost'), failed('soft:rounds'), failed('hard:cost')], 3)).toBe(null)
  })

  it('never stops a fan-out that has answered something', () => {
    expect(failingAlike([{ started: true, answered: true }, failed('x'), failed('x'), failed('x')], 3)).toBe(null)
  })
})

describe('a part is a part, whatever its name looks like', () => {
  // `report--north` and `report--south` are two parts. Splitting on any `--` made them
  // one, and only the last-sorted directory was ever scheduled.
  it('reserves the retry suffix for attempts, not for names containing --', () => {
    part('report--north')
    part('report--south')
    const plan = planFanout(PARTS, { prompt: 'in.md' })
    expect(plan.run.map(r => r.part).sort()).toEqual(['report--north', 'report--south'])
  })

  it('still counts a numbered suffix as an attempt at the same part', () => {
    part('alpha', { frame: { ws: 'alpha', running: true } })
    part('alpha--2')
    const plan = planFanout(PARTS, { prompt: 'in.md' })
    expect(plan.run.map(r => r.part)).toEqual(['alpha'])
  })
})

describe('what a retry is given', () => {
  // Copying only the prompt was right for a self-contained one and silently wrong for
  // everything else: the cell arrived without the file its prompt told it to read.
  it('stages the whole part, not just the prompt file', () => {
    const from = resolve(PARTS, 'one')
    mkdirSync(resolve(from, 'inputs'), { recursive: true })
    writeFileSync(resolve(from, 'in.md'), 'read inputs/data.csv')
    writeFileSync(resolve(from, 'inputs/data.csv'), 'a,b\n1,2\n')

    const ws = stageAttempt({ ws: resolve(PARTS, 'one--2'), from }, 'in.md')

    expect(readFileSync(resolve(ws, 'in.md'), 'utf8')).toBe('read inputs/data.csv')
    expect(readFileSync(resolve(ws, 'inputs/data.csv'), 'utf8')).toBe('a,b\n1,2\n')
  })

  it('leaves behind what the spent attempt produced', () => {
    const from = resolve(PARTS, 'two')
    mkdirSync(resolve(from, 'data'), { recursive: true })
    writeFileSync(resolve(from, 'in.md'), 'go')
    writeFileSync(resolve(from, 'spawn.json'), '{}')
    writeFileSync(resolve(from, 'data/out.json'), '{"half":true}')

    const ws = stageAttempt({ ws: resolve(PARTS, 'two--2'), from }, 'in.md')

    expect(existsSync(resolve(ws, 'in.md'))).toBe(true)
    // A workspace holding either of these is one planSpawn refuses.
    expect(existsSync(resolve(ws, 'spawn.json'))).toBe(false)
    expect(existsSync(resolve(ws, 'data/out.json'))).toBe(false)
  })

  it('keeps the part\'s own files that a spore would have, since a cell run makes none of them', () => {
    const from = resolve(PARTS, 'three')
    mkdirSync(from, { recursive: true })
    writeFileSync(resolve(from, 'in.md'), 'go')
    writeFileSync(resolve(from, 'reference.md'), 'the part\'s reference')
    writeFileSync(resolve(from, 'spawn.json'), '{}')

    const ws = stageAttempt({ ws: resolve(PARTS, 'three--2'), from }, 'in.md')

    expect(readFileSync(resolve(ws, 'reference.md'), 'utf8')).toBe('the part\'s reference')
  })
})

describe('what a retry costs', () => {
  // Material is staged into a part by linking, which is how one 23 MB file is shared by
  // fifty parts. `cpSync` does not preserve that, so retrying turned each shared file
  // into a real copy — a fan-out of eight went from 24 MB to 214 MB.
  it('keeps a hardlink a hardlink', () => {
    const from = resolve(PARTS, 'one')
    mkdirSync(resolve(from, 'context'), { recursive: true })
    writeFileSync(resolve(from, 'in.md'), 'go')
    const shared = resolve(PARTS, 'shared.csv')
    writeFileSync(shared, 'a,b\n1,2\n')
    linkSync(shared, resolve(from, 'context', 'big.csv'))

    const ws = stageAttempt({ ws: resolve(PARTS, 'one--2'), from }, 'in.md')

    expect(statSync(resolve(ws, 'context', 'big.csv')).ino).toBe(statSync(shared).ino)
  })
})
