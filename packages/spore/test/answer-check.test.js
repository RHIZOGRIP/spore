/**
 * A spore's answer check, from `spore send` through the runner to the records: a real program in
 * `checks/`, run on the answer a turn is about to end on.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startGate } from './fixtures/model-server.js'
import { answers, calls, scriptedMo } from './fixtures/scripted-model.js'
import { outsideRoot, outsideWorkspace } from './fixtures/outside-ws.js'
import { readEvents, readTurns } from '../src/core/spore-dir.js'

const run = promisify(execFile)
const SPORE = resolve(dirname(fileURLToPath(import.meta.url)), '../../spore-cli/bin/spore.js')

let ws
let home
let gate
let forked

const NO_BAD = '#!/bin/sh\nif grep -q BAD; then printf \'{"tell":"it says BAD, which no answer may"}\'; else printf \'{"ok":true}\'; fi\n'
const CELL = '---\nname: answer\nrounds: [3, 4]\ncost: [0.10, 0.15]\nwall: [1m, 2m]\non-wrap: discard\n---\n\nYou check an answer.\n'

const start = async (name, reply, checks = {}) => {
  ws = outsideWorkspace(name)
  if (Object.keys(checks).length) mkdirSync(resolve(ws, 'checks'))
  for (const [file, source] of Object.entries(checks)) writeFileSync(resolve(ws, 'checks', file), source, { mode: 0o755 })
  home = outsideRoot(`${name}-config`)
  const mo = scriptedMo(reply)
  gate = await startGate({ mo, name })
  gate.configure({}, resolve(home, 'spore', 'config.json'))
  return mo
}

const spore = (...args) => run(process.execPath, [SPORE, ...args], {
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_CONFIG_HOME: home
  }
}).catch(err => err)

const checked = () => readEvents(ws, { event: 'answer_check' })

afterEach(async () => {
  await gate.close()
  for (const dir of [ws, home, forked]) if (dir) rmSync(dir, { recursive: true, force: true })
  forked = null
})

describe('an answer check', () => {
  it('lets an answer it passes end the turn, with no extra round', { timeout: 30_000 }, async () => {
    const mo = await start('answer-check-ok', () => answers('all good'), { 'answer.check': NO_BAD })
    await spore('send', ws, 'hello')

    expect(mo.seen).toHaveLength(1)
    expect(readTurns(ws).at(-1)).toMatchObject({ stopReason: 'answer', output: 'all good', rounds: 1 })
    expect(checked()).toMatchObject([{ round: 0, by: 'program', verdict: 'ok', told: false, afterTelling: false }])
  })

  it('sends a failed answer back once, and the next one goes out whatever its check says', { timeout: 30_000 }, async () => {
    const mo = await start('answer-check-tell', (input, i) => [answers('BAD one'), answers('BAD two')][i], { 'answer.check': NO_BAD })
    await spore('send', ws, 'hello')

    expect(mo.seen).toHaveLength(2)
    expect(JSON.stringify(mo.seen[1])).toContain('[System: before this answer goes out: it says BAD, which no answer may')
    expect(readTurns(ws).at(-1)).toMatchObject({ stopReason: 'answer', output: 'BAD two', rounds: 2 })
    expect(checked()).toMatchObject([
      { round: 0, verdict: 'tell', tell: 'it says BAD, which no answer may', told: true, afterTelling: false },
      { round: 1, verdict: 'tell', told: false, afterTelling: true }
    ])
  })

  it('runs a check written for node', { timeout: 30_000 }, async () => {
    const mo = await start('answer-check-js', (input, i) => [answers('BAD'), answers('fine')][i], {
      'answer.check.js': "let said = ''\nprocess.stdin.on('data', d => { said += d }).on('end', () => console.log(JSON.stringify(said.includes('BAD') ? { tell: 'no BAD' } : { ok: true })))\n"
    })
    await spore('send', ws, 'hello')

    expect(mo.seen).toHaveLength(2)
    expect(readTurns(ws).at(-1)).toMatchObject({ output: 'fine' })
    expect(checked()).toMatchObject([{ verdict: 'tell', told: true }, { verdict: 'ok', afterTelling: true }])
  })

  it.each([
    ['exits non-zero', '#!/bin/sh\necho broken >&2\nexit 3\n', 'exited 3 — broken'],
    ['prints something that is not JSON', '#!/bin/sh\necho looks fine\n', 'printed something that is not one JSON object'],
    ['answers neither ok nor a tell', '#!/bin/sh\nprintf \'{"tell":""}\'\n', 'answered neither { "ok": true } nor a tell'],
    ['asks for a cell the spore does not keep', '#!/bin/sh\nprintf \'{"ask":true}\'\n', 'asked for a cell, and there is no checks/answer.cmk']
  ])('lets the answer out when its check %s', { timeout: 30_000 }, async (how, source, why) => {
    const mo = await start('answer-check-failed', () => answers('BAD'), { 'answer.check': source })
    await spore('send', ws, 'hello')

    expect(mo.seen).toHaveLength(1)
    expect(readTurns(ws).at(-1)).toMatchObject({ stopReason: 'answer', output: 'BAD' })
    expect(checked()).toMatchObject([{ verdict: 'failed', why, told: false }])
  })

  it('lets the answer out when its check runs past its time', { timeout: 40_000 }, async () => {
    const mo = await start('answer-check-slow', () => answers('BAD'), { 'answer.check': '#!/bin/sh\nsleep 60\n' })
    await spore('send', ws, 'hello')

    expect(mo.seen).toHaveLength(1)
    expect(readTurns(ws).at(-1)).toMatchObject({ stopReason: 'answer', output: 'BAD' })
    expect(checked()).toMatchObject([{ verdict: 'failed', told: false }])
    expect(checked()[0].why).toMatch(/^was stopped after/)
  })

  it('cannot write into the workspace', { timeout: 30_000 }, async () => {
    await start('answer-check-confined', () => answers('all good'), {
      'answer.check': '#!/bin/sh\necho x > data/written\necho x > checks/written\nprintf \'{"ok":true}\'\n'
    })
    await spore('send', ws, 'hello')

    expect(checked()).toMatchObject([{ verdict: 'ok' }])
    expect(existsSync(resolve(ws, 'data', 'written'))).toBe(false)
    expect(existsSync(resolve(ws, 'checks', 'written'))).toBe(false)
  })

  it('is not the agent\'s to write', { timeout: 30_000 }, async () => {
    const mo = await start('answer-check-unwritable', (input, i) => [
      calls('write', { path: 'checks/answer.check', content: '#!/bin/sh\nprintf \'{"ok":true}\'\n' }),
      calls('wsexec', { command: 'echo x > checks/answer.check', out: 'data/a.txt' }),
      answers('all good')
    ][i], { 'answer.check': NO_BAD })
    await spore('send', ws, 'hello')

    expect(JSON.stringify(mo.seen[1])).toContain('checks/answer.check is not writable')
    expect(readFileSync(resolve(ws, 'checks', 'answer.check'), 'utf8')).toBe(NO_BAD)
  })

  it('runs its cell when the program asks, and the cell\'s cost lands on the turn', { timeout: 60_000 }, async () => {
    const mo = await start('answer-check-ask', (input, i) => [
      answers('first'),
      answers('{ "tell": "cite by id" }'),
      answers('second'),
      answers('{ "ok": true }')
    ][i], { 'answer.check': '#!/bin/sh\nprintf \'{"ask":true}\'\n', 'answer.cmk': CELL })
    await spore('send', ws, 'hello')

    expect(mo.seen).toHaveLength(4)
    expect(JSON.stringify(mo.seen[1])).toContain('A turn is about to end on the answer below')
    expect(JSON.stringify(mo.seen[2])).toContain('[System: before this answer goes out: cite by id')
    const turn = readTurns(ws).at(-1)
    expect(turn).toMatchObject({ stopReason: 'answer', output: 'second' })
    expect(turn.treeMicros).toBeGreaterThan(turn.ownMicros)
    expect(checked()).toMatchObject([
      { by: 'cell', verdict: 'tell', tell: 'cite by id', told: true },
      { by: 'cell', verdict: 'ok', afterTelling: true }
    ])
  })

  it('runs its cell when the spore keeps no program', { timeout: 60_000 }, async () => {
    const mo = await start('answer-check-cell', (input, i) => [answers('first'), answers('{ "ok": true }')][i], { 'answer.cmk': CELL })
    await spore('send', ws, 'hello')

    expect(mo.seen).toHaveLength(2)
    expect(readTurns(ws).at(-1)).toMatchObject({ stopReason: 'answer', output: 'first' })
    expect(checked()).toMatchObject([{ by: 'cell', verdict: 'ok' }])
  })

  it('lets the first answer out when a hard limit ends the correction', { timeout: 30_000 }, async () => {
    const mo = await start('answer-check-released', (input, i) => [
      answers('BAD'),
      calls('exec', { command: 'true', out: 'data/a.txt' }),
      calls('exec', { command: 'true', out: 'data/b.txt' })
    ][i], { 'answer.check': NO_BAD })
    const cmk = resolve(ws, 'spore.cmk')
    writeFileSync(cmk, readFileSync(cmk, 'utf8').replace(/^rounds: .*$/m, 'rounds: [2, 3]'))
    await spore('send', ws, 'hello')

    expect(mo.seen).toHaveLength(3)
    expect(readTurns(ws).at(-1)).toMatchObject({ stopReason: 'answer', output: 'BAD', rounds: 3 })
    expect(checked()).toMatchObject([{ verdict: 'tell', told: true }, { round: 3, released: true, because: 'hard:rounds' }])
  })

  it('leaves a wrapped answer unchecked', { timeout: 30_000 }, async () => {
    const mo = await start('answer-check-wrapped', (input, i) => [
      calls('exec', { command: 'true', out: 'data/a.txt' }),
      answers('BAD')
    ][i], { 'answer.check': NO_BAD })
    const cmk = resolve(ws, 'spore.cmk')
    writeFileSync(cmk, readFileSync(cmk, 'utf8').replace(/^rounds: .*$/m, 'rounds: [1, 3]'))
    await spore('send', ws, 'hello')

    expect(mo.seen).toHaveLength(2)
    expect(readTurns(ws).at(-1)).toMatchObject({ stopReason: 'soft:rounds', output: 'BAD' })
    expect(checked()).toEqual([])
  })

  it('is not there for a spore that keeps none', { timeout: 30_000 }, async () => {
    const mo = await start('answer-check-none', () => answers('BAD'))
    await spore('send', ws, 'hello')

    expect(mo.seen).toHaveLength(1)
    expect(readTurns(ws).at(-1)).toMatchObject({ stopReason: 'answer', output: 'BAD' })
    expect(checked()).toEqual([])
  })

  it('goes with a fork', { timeout: 30_000 }, async () => {
    await start('answer-check-fork', () => answers('all good'), { 'answer.check': NO_BAD })
    await spore('send', ws, 'hello')
    forked = `${ws}-fork`
    await spore('fork', ws, forked)

    expect(readFileSync(resolve(forked, 'checks', 'answer.check'), 'utf8')).toBe(NO_BAD)
  })
})
