import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { pauseSpores, unpauseSpores } from '../src/core/admission.js'
import { runCell } from '../src/core/cell.js'
import { cellsSince } from '../src/core/spore-dir.js'
import { definitionWith } from '../src/core/identity-defaults.js'

const DIGEST = '---\nname: digest\ntools: [read]\nrounds: [3, 4]\ncost: [0.05, 0.10]\nwall: [1m, 2m]\non-wrap: discard\n---\n\nYou write a digest.\n'

let dir
let ws
let env

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spore-cell-'))
  ws = join(dir, 'watcher')
  mkdirSync(join(ws, 'precursors'), { recursive: true })
  writeFileSync(join(ws, 'spore.cmk'), definitionWith('fake/root'))
  writeFileSync(join(ws, 'precursors', 'digest.cmk'), DIGEST)
  env = { XDG_STATE_HOME: join(dir, 'state') }
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const rows = () => {
  const db = new DatabaseSync(join(ws, 'state.sqlite'), { readOnly: true })
  try {
    return db.prepare('SELECT precursor, origin, ref, answer, error, costUsd FROM cells ORDER BY cellNo').all()
  } finally {
    db.close()
  }
}

describe('a cell outside any turn', () => {
  it('runs for any origin, with the files and briefing it is given, and records the run in the spore', async () => {
    writeFileSync(join(dir, 'notes.md'), 'what happened today')
    let asked
    const ran = await runCell({
      ws,
      precursor: 'digest',
      origin: 'schedule:daily',
      files: { 'notes.md': join(dir, 'notes.md') },
      briefing: 'Write today\'s digest from notes.md.\n',
      env,
      launch: async (question) => {
        asked = { ...question, notes: readFileSync(join(question.cellWs, 'notes.md'), 'utf8'), briefing: readFileSync(join(question.cellWs, question.prompt), 'utf8') }
        return { answer: 'Quiet day.', costUsd: 0.004, durationMs: 800, failed: null }
      }
    })
    expect(ran).toMatchObject({ answer: 'Quiet day.', failed: null, started: true })
    expect(asked).toMatchObject({ precursor: 'digest', model: 'fake/root', wallMs: 120_000, notes: 'what happened today', briefing: 'Write today\'s digest from notes.md.\n' })
    expect(asked.cellWs.startsWith(join(dir, 'state', 'spore', 'cells', 'watcher', 'schedule-daily'))).toBe(true)
    expect(rows()).toEqual([{ precursor: 'digest', origin: 'schedule:daily', ref: null, answer: 'Quiet day.', error: null, costUsd: 0.004 }])
    expect(cellsSince(ws, { since: '2000-01-01T00:00:00.000Z' })).toEqual({ runs: 1, costUsd: 0.004, origins: { 'schedule:daily': 1 } })
  })

  it('runs on the model its precursor names in the spore\'s cell-models, on the spore\'s with none, and not at all on a name it lacks', async () => {
    const launched = []
    const launch = async (question) => { launched.push({ model: question.model, map: question.env.SPORE_CELL_MODELS }); return { answer: 'ok', costUsd: 0, durationMs: 1, failed: null } }
    writeFileSync(join(ws, 'precursors', 'digest.cmk'), DIGEST.replace('tools: [read]\n', 'model: low\ntools: [read]\n'))

    await runCell({ ws, precursor: 'digest', origin: 'command', briefing: 'x\n', env, launch })
    writeFileSync(join(ws, 'spore.cmk'), definitionWith('fake/root').replace('\n---\n', '\ncell-models: [low=fake/cheap]\n---\n'))
    await runCell({ ws, precursor: 'digest', origin: 'command', briefing: 'x\n', env, launch })
    expect(launched).toEqual([
      { model: 'fake/root', map: undefined },
      { model: 'fake/cheap', map: '{"low":"fake/cheap"}' }
    ])

    writeFileSync(join(ws, 'precursors', 'digest.cmk'), DIGEST.replace('tools: [read]\n', 'model: strong\ntools: [read]\n'))
    const refused = await runCell({ ws, precursor: 'digest', origin: 'command', briefing: 'x\n', env, launch })
    expect(refused).toMatchObject({ started: false, failed: expect.stringMatching(/cell model "strong", which this spore's cell-models does not have — it has low/) })
  })

  it('carries the spore\'s auth to the cell, whom its calls are for on a gate', async () => {
    const launched = []
    const launch = async (question) => { launched.push(question.auth); return { answer: 'ok', costUsd: 0, durationMs: 1, failed: null } }
    await runCell({ ws, precursor: 'digest', origin: 'command', briefing: 'x\n', env, launch })
    writeFileSync(join(ws, 'spore.cmk'), definitionWith('fake/root').replace('\n---\n', '\nauth: thread-7f3a\n---\n'))
    await runCell({ ws, precursor: 'digest', origin: 'command', briefing: 'x\n', env, launch })
    expect(launched).toEqual([undefined, 'thread-7f3a'])
  })

  it('does not start while spores are paused', async () => {
    pauseSpores()
    try {
      const ran = await runCell({ ws, precursor: 'digest', origin: 'command', briefing: 'x\n', env, launch: async () => { throw new Error('never launched') } })
      expect(ran).toMatchObject({ started: false, failed: 'spores are paused' })
      expect(cellsSince(ws, { since: '2000-01-01T00:00:00.000Z' }).runs).toBe(0)
    } finally {
      unpauseSpores()
    }
  })

  it('records a run that failed or gave nothing, and none that never started', async () => {
    await runCell({ ws, precursor: 'digest', origin: 'command', ref: 'r-1', briefing: 'x\n', env, launch: async () => ({ answer: null, costUsd: 0.01, durationMs: 120_000, failed: 'ended 1 — past its wall' }) })
    await runCell({ ws, precursor: 'digest', origin: 'command', briefing: 'x\n', env, launch: async () => ({ answer: null, costUsd: 0, durationMs: 50, failed: null }) })
    writeFileSync(join(ws, 'precursors', 'digest.cmk'), DIGEST.replace('on-wrap: discard\n', ''))
    const unstarted = await runCell({ ws, precursor: 'digest', origin: 'command', briefing: 'x\n', env, launch: async () => { throw new Error('never launched') } })
    expect(unstarted).toMatchObject({ started: false, failed: expect.stringMatching(/precursors\/digest\.cmk .*on-wrap/) })
    expect(rows().map(row => [row.ref, row.error])).toEqual([['r-1', 'ended 1 — past its wall'], [null, 'gave no answer']])
    expect(existsSync(join(dir, 'state', 'spore', 'cells', 'watcher', 'command'))).toBe(true)
  })
})
