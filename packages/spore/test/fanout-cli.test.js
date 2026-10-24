/**
 * The fan-out executable, over real cells.
 *
 * `fanout.test.js` covers the planning helpers directly — which part runs next, what a
 * retry inherits, when to stop. What it cannot cover is the program: the report it
 * prints, the exit code a reducer reads, and what happens to parts that were skipped,
 * never started, killed at the deadline or died before writing a frame.
 *
 * Every cell here is a real `spawn.js` under Landlock; only the provider is scripted,
 * per part, from the prompt each part carries.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createModelServer, suppliedKey } from './fixtures/model-server.js'
import { brokerSocketPath } from '../src/infra/broker-socket.js'
import { writeTurnRecords } from '../src/core/spore-dir.js'
import { outsideRoot } from './fixtures/outside-ws.js'
import { answers, calls, scriptedMo } from './fixtures/scripted-model.js'

const run = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const FANOUT = resolve(__dirname, '../bin/fanout.js')

let root
let broker

const asked = (input) => String(input.find(m => m.role === 'user')?.content ?? '')

const part = (name, { prompt = `part ${name}`, frame, turn, extra } = {}) => {
  const ws = resolve(root, 'parts', name)
  mkdirSync(ws, { recursive: true })
  if (prompt !== null) writeFileSync(resolve(ws, 'in.md'), prompt)
  if (extra) writeFileSync(resolve(ws, 'material.txt'), extra)
  if (frame) writeFileSync(resolve(ws, 'spawn.json'), JSON.stringify(frame) + '\n')
  if (turn) writeTurnRecords(ws, [turn])
  return ws
}

const fanout = async (args) => {
  try {
    const { stdout, stderr } = await run(process.execPath, [FANOUT, ...args], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MODEL: 'anthropic/claude-haiku-4-5',
        SPORE_MODEL_SOCKET: broker.socketPath
      }
    })
    return { code: 0, report: JSON.parse(stdout), stderr }
  } catch (e) {
    return { code: e.code, report: e.stdout ? JSON.parse(e.stdout) : null, stderr: e.stderr }
  }
}

const start = async (reply) => {
  broker = createModelServer({
    mo: scriptedMo(reply),
    socketPath: brokerSocketPath('fanout-test'),
    limit: 10,
    key: suppliedKey(root)
  })
  await broker.listen()
}

const eachAnswers = async (input) => answers(asked(input).toUpperCase())

beforeEach(() => {
  root = outsideRoot('fanout-cli')
  mkdirSync(resolve(root, 'precursors'), { recursive: true })
  mkdirSync(resolve(root, 'parts'), { recursive: true })
  writeFileSync(resolve(root, 'precursors/worker.cmk'),
    '---\nname: worker\ntools: [read, write]\nrounds: [4, 6]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: keep\n---\n\nYou answer with the result.\n')
})

afterEach(async () => {
  await broker?.close()
  broker = null
  rmSync(root, { recursive: true, force: true })
})

describe('a fan-out that finishes', () => {
  it('answers every part and says so', async () => {
    part('a'); part('b'); part('c')
    await start(eachAnswers)

    const r = await fanout(['--precursor', 'worker', '--parts', 'parts', '--answer', 'data/out.txt'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.report.parts).toBe(3)
    expect(r.report.answered).toBe(3)
    expect(r.report.unfinished).toEqual([])
    expect(r.report.answers.sort()).toEqual(['parts/a/data/out.txt', 'parts/b/data/out.txt', 'parts/c/data/out.txt'])
    expect(readFileSync(resolve(root, 'parts/a/data/out.txt'), 'utf8')).toBe('PART A')
    // Every cell spent through the one broker, and the report adds up to what it saw.
    expect(r.report.cost).toBeCloseTo(broker.ledger.children, 5)
    // A line on stderr as each part ends, so a fan-out run by exec never looks idle.
    expect(r.stderr.match(/^fanout: \S+ answered — \d of 3 ended, \d running$/gm)).toHaveLength(3)
  })
})

describe('a fan-out that has to finish what an earlier one left', () => {
  it('retries a started part beside itself, with its material', async () => {
    // A workspace that ran and did not answer. It is spent — `planSpawn` refuses a
    // second run there — so the retry is a sibling.
    part('a', { extra: 'the material', frame: { precursor: 'worker', answer: null, stopReason: 'hard:rounds' }, turn: { startedAt: '2026-01-01T00:00:00.000Z', stopReason: 'hard:rounds', concluded: false, ownMicros: 20000, treeMicros: 20000 } })
    await start(eachAnswers)

    const r = await fanout(['--precursor', 'worker', '--parts', 'parts', '--answer', 'data/out.txt'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.report.answered).toBe(1)
    expect(r.report.answers).toEqual(['parts/a--2/data/out.txt'])
    // Staged from the first attempt, not just the prompt: a part whose prompt names a
    // file it was given has to be given it again.
    expect(readFileSync(resolve(root, 'parts/a--2/material.txt'), 'utf8')).toBe('the material')
    expect(existsSync(resolve(root, 'parts/a--2/spawn.json'))).toBe(true)
  })

  it('skips a part it cannot retry, and still counts it', async () => {
    part('a')
    part('b', { prompt: null, frame: { precursor: 'worker', answer: null, stopReason: 'error' } })
    await start(eachAnswers)

    const r = await fanout(['--precursor', 'worker', '--parts', 'parts', '--answer', 'data/out.txt'])
    // Not every part answered, so the run failed — a batch that quietly drops a part
    // and exits 0 is the reason this compares against the whole plan.
    expect(r.code).toBe(1)
    expect(r.report.parts).toBe(2)
    expect(r.report.answered).toBe(1)
    expect(r.report.skipped).toEqual([{ part: 'b', reason: 'no in.md to retry from' }])
  })

  it('reports a part whose spawn died before it could write a frame', async () => {
    part('a')
    part('broken', { prompt: null })
    await start(eachAnswers)

    const r = await fanout(['--precursor', 'worker', '--parts', 'parts', '--answer', 'data/out.txt'])
    expect(r.code).toBe(1)
    expect(r.report.answered).toBe(1)
    expect(r.report.failed).toEqual([{ part: 'broken', error: 'spawn: prompt not found — in.md' }])
    // The same sentence is left in the part, because a report scrolls past and the
    // workspace is what an agent goes back to.
    expect(readFileSync(resolve(root, 'parts/broken/spawn.err'), 'utf8')).toMatch(/prompt not found/)
  })
})

describe('a fan-out that stops', () => {
  it('stops early when the first parts fail alike, and says what never started', async () => {
    for (const name of ['a', 'b', 'c', 'd', 'e']) part(name)
    writeFileSync(resolve(root, 'precursors/stubborn.cmk'),
      '---\nname: stubborn\ntools: [read, write]\nrounds: [1, 2]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: keep\n---\n\nYou answer with the result.\n')
    // Never answers, so every cell ends the same way: the hard round bound.
    await start(async () => calls('write', { path: 'data/scratch.txt', content: 'x' }))

    // Width one, so this is not a race: parts run in name order, the third failure is
    // seen in the same iteration it lands, and nothing after it was ever started. At
    // width two the fourth and fifth may already be running by then, which is correct
    // behaviour and a coin toss to assert.
    const r = await fanout(['--precursor', 'stubborn', '--parts', 'parts', '--answer', 'data/out.txt', '--width', '1'])
    expect(r.code).toBe(1)
    expect(r.report.stoppedEarly).toBe('hard:rounds')
    expect(r.report.answered).toBe(0)
    expect(r.report.neverStarted).toEqual([{ part: 'd' }, { part: 'e' }])
    // Everything is accounted for: what ran, what never did, nothing dropped.
    expect(r.report.parts).toBe(5)
    expect(r.report.unfinished.length + r.report.neverStarted.length).toBe(5)
  })

  it('kills what is still running at the deadline and reports it', async () => {
    part('slow')
    await start(async (input) => {
      await new Promise(resolve => setTimeout(resolve, 30000))
      return answers('too late')
    })

    const r = await fanout(['--precursor', 'worker', '--parts', 'parts', '--answer', 'data/out.txt', '--timeout', '1'])
    expect(r.code).toBe(1)
    expect(r.report.timedOut).toBe(true)
    expect(r.report.answered).toBe(0)
    expect(existsSync(resolve(root, 'parts/slow/data/out.txt'))).toBe(false)
  })
})
