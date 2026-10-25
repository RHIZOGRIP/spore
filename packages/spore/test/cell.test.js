import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'

import { pauseSpores, unpauseSpores } from '../src/core/admission.js'
import { runCell } from '../src/core/cell.js'
import { cellsSince } from '../src/core/spore-dir.js'
import { definitionWith } from '../src/testing.js'
import { brokerSocketPath } from '../src/infra/broker-socket.js'
import { CONFIG_FILE } from '../src/library/config.js'
import { createGate } from './fixtures/model-server.js'
import { answers, scriptedMo } from './fixtures/scripted-model.js'
import { outsideRoot } from './fixtures/outside-ws.js'

const DIGEST = '---\nname: digest\ntools: [read]\nrounds: [3, 4]\ncost: [0.05, 0.10]\nwall: [1m, 2m]\non-wrap: discard\n---\n\nYou write a digest.\n'
const sporeWith = (lines = '') => definitionWith('fake/root').replace('\n---\n', `\nauth: watcher-1\n${lines}---\n`)

let gate
let reply
let dir
let ws

const env = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME })

beforeAll(async () => {
  gate = createGate({ mo: scriptedMo((input) => reply(input)), socketPath: brokerSocketPath('cell-gate') })
  await gate.listen()
  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify({ gate: gate.socketPath }))
})

afterAll(() => gate.close())

beforeEach(() => {
  reply = () => answers('ok')
  gate.envelopes.length = 0
  dir = outsideRoot('cell')
  ws = join(dir, 'watcher')
  mkdirSync(join(ws, 'precursors'), { recursive: true })
  writeFileSync(join(ws, 'spore.cmk'), sporeWith())
  writeFileSync(join(ws, 'precursors', 'digest.cmk'), DIGEST)
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
    reply = () => answers('Quiet day.', 0.004)
    let wall
    const ran = await runCell({
      ws,
      precursor: 'digest',
      origin: 'schedule:daily',
      files: { 'notes.md': join(dir, 'notes.md') },
      briefing: 'Write today\'s digest from notes.md.\n',
      env: env(),
      starting: (wallMs) => { wall = wallMs }
    })
    expect(ran).toMatchObject({ answer: 'Quiet day.', failed: null, started: true, costUsd: 0.004 })
    expect(wall).toBe(120_000)
    expect(ran.cellWs.startsWith(join(process.env.XDG_STATE_HOME, 'spore', 'cells', 'watcher', 'schedule-daily'))).toBe(true)
    expect(readFileSync(join(ran.cellWs, 'notes.md'), 'utf8')).toBe('what happened today')
    expect(gate.envelopes).toHaveLength(1)
    expect(gate.envelopes[0].model).toBe('fake/root')
    expect(JSON.stringify(gate.envelopes[0].prompt)).toContain('Write today\'s digest from notes.md.')
    expect(rows()).toEqual([{ precursor: 'digest', origin: 'schedule:daily', ref: null, answer: 'Quiet day.', error: null, costUsd: 0.004 }])
    expect(cellsSince(ws, { since: '2000-01-01T00:00:00.000Z' })).toEqual({ runs: 1, costUsd: 0.004, origins: { 'schedule:daily': 1 } })
  })

  it('runs on the model its precursor names in the spore\'s cell-models, on the spore\'s with none, and not at all on a name it lacks', async () => {
    writeFileSync(join(ws, 'precursors', 'digest.cmk'), DIGEST.replace('tools: [read]\n', 'model: low\ntools: [read]\n'))

    await runCell({ ws, precursor: 'digest', origin: 'command', briefing: 'x\n', env: env() })
    writeFileSync(join(ws, 'spore.cmk'), sporeWith('cell-models: [low=fake/cheap]\n'))
    await runCell({ ws, precursor: 'digest', origin: 'command', briefing: 'x\n', env: env() })
    expect(gate.envelopes.map(envelope => envelope.model)).toEqual(['fake/root', 'fake/cheap'])

    writeFileSync(join(ws, 'precursors', 'digest.cmk'), DIGEST.replace('tools: [read]\n', 'model: strong\ntools: [read]\n'))
    const refused = await runCell({ ws, precursor: 'digest', origin: 'command', briefing: 'x\n', env: env() })
    expect(refused).toMatchObject({ started: false, failed: expect.stringMatching(/cell model "strong", which this spore's cell-models does not have — it has low/) })
    expect(gate.envelopes).toHaveLength(2)
  })

  it('calls the host\'s gate under the spore\'s auth, and is refused there without one', async () => {
    expect(await runCell({ ws, precursor: 'digest', origin: 'command', briefing: 'x\n', env: env() })).toMatchObject({ answer: 'ok', failed: null })
    expect(gate.envelopes.map(envelope => envelope.authId)).toEqual(['watcher-1'])

    writeFileSync(join(ws, 'spore.cmk'), definitionWith('fake/root'))
    const unnamed = await runCell({ ws, precursor: 'digest', origin: 'command', briefing: 'x\n', env: env() })
    expect(unnamed).toMatchObject({ answer: null, started: true, failed: expect.stringMatching(/names no auth — add auth: <id> to its spore\.cmk/) })
    expect(gate.envelopes).toHaveLength(1)
  })

  it('does not start while spores are paused', async () => {
    pauseSpores()
    try {
      const ran = await runCell({ ws, precursor: 'digest', origin: 'command', briefing: 'x\n', env: env() })
      expect(ran).toMatchObject({ started: false, failed: 'spores are paused' })
      expect(cellsSince(ws, { since: '2000-01-01T00:00:00.000Z' }).runs).toBe(0)
      expect(gate.envelopes).toEqual([])
    } finally {
      unpauseSpores()
    }
  })

  it('records a run that failed, and none that never started', async () => {
    reply = () => { throw Object.assign(new Error('the provider is down'), { type: 'PROVIDER_ERROR', detail: 'refused for good' }) }
    const failed = await runCell({ ws, precursor: 'digest', origin: 'command', ref: 'r-1', briefing: 'x\n', env: env() })
    expect(failed).toMatchObject({ answer: null, started: true, failed: expect.stringMatching(/^exited 1/) })
    writeFileSync(join(ws, 'precursors', 'digest.cmk'), DIGEST.replace('on-wrap: discard\n', ''))
    const unstarted = await runCell({ ws, precursor: 'digest', origin: 'command', briefing: 'x\n', env: env() })
    expect(unstarted).toMatchObject({ started: false, failed: expect.stringMatching(/precursors\/digest\.cmk .*on-wrap/) })
    expect(rows().map(row => [row.ref, row.error])).toEqual([['r-1', failed.failed]])
    expect(existsSync(join(process.env.XDG_STATE_HOME, 'spore', 'cells', 'watcher', 'command'))).toBe(true)
  })
})
