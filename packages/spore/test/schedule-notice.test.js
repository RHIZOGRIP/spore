/**
 * A schedule a turn writes around `write`'s check, from `spore send` through the runner to the
 * records: the answer that follows goes back to the model with why the schedule will not fire,
 * once, and the turn goes on from there.
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

const BROKEN = "printf -- '---\\nat: 2030-01-01T09:00:00+01:00\\n---\\n\\nCall the bank.\\n' > schedules/call-bank.cmk"

const start = async (name, reply) => {
  ws = outsideWorkspace(name)
  const cmk = resolve(ws, 'spore.cmk')
  writeFileSync(cmk, readFileSync(cmk, 'utf8').replace(/^(tools: .*)$/m, '$1\nschedules: [2, 1h]'))
  home = outsideRoot(`${name}-config`)
  const mo = scriptedMo(reply)
  gate = await startGate({ mo, name })
  gate.configure({}, resolve(home, 'spore', 'config.json'))
  return mo
}

const spore = (prompt) => run(process.execPath, [SPORE, 'send', ws, prompt], {
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_CONFIG_HOME: home
  }
}).catch(err => err)

afterEach(async () => {
  await gate.close()
  rmSync(ws, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

describe('a schedule written this turn that will not fire', () => {
  it('sends the answer back once with why, and the turn goes on to fix it', { timeout: 30_000 }, async () => {
    const mo = await start('schedule-notice', (input, i) => [
      calls('wsexec', { command: BROKEN }),
      answers('I will remind you.'),
      calls('wsexec', { command: 'rm schedules/call-bank.cmk' }),
      answers('No reminder is set.')
    ][i])
    await spore('remind me to call the bank')

    expect(JSON.stringify(mo.seen[2])).toContain('schedules/call-bank.cmk: unknown field')
    expect(readTurns(ws).at(-1)).toMatchObject({ stopReason: 'answer', output: 'No reminder is set.' })
    expect(readEvents(ws, { event: 'schedule_refused' })).toMatchObject([{ answered: false, schedules: [{ path: 'schedules/call-bank.cmk' }] }])
    expect(existsSync(resolve(ws, 'schedules', 'call-bank.cmk'))).toBe(false)
  })

  it('names a file that is no schedule by its name, which would never fire', { timeout: 30_000 }, async () => {
    const mo = await start('schedule-notice-name', (input, i) => [
      calls('wsexec', { command: "printf -- '---\\nwhen: at 2030-01-01T09:00:00+01:00\\n---\\n\\nCall the bank.\\n' > schedules/call-bank.toml" }),
      answers('I will remind you.'),
      calls('wsexec', { command: 'mv schedules/call-bank.toml schedules/call-bank.cmk' }),
      answers('I will remind you.')
    ][i])
    await spore('remind me to call the bank')

    expect(JSON.stringify(mo.seen[2])).toContain('schedules/call-bank.toml: schedules/ holds only <name>.cmk files')
    expect(readTurns(ws).at(-1)).toMatchObject({ stopReason: 'answer', output: 'I will remind you.' })
    expect(readEvents(ws, { event: 'schedule_refused' })).toMatchObject([{ answered: false, schedules: [{ path: 'schedules/call-bank.toml' }] }])
    expect(existsSync(resolve(ws, 'schedules', 'call-bank.cmk'))).toBe(true)
  })

  it('leaves alone one that was already there when the turn began', { timeout: 30_000 }, async () => {
    const mo = await start('schedule-notice-earlier', () => answers('done'))
    mkdirSync(resolve(ws, 'schedules'))
    writeFileSync(resolve(ws, 'schedules', 'call-bank.cmk'), '---\nat: 2030-01-01T09:00:00+01:00\n---\n\nCall the bank.\n')
    await spore('hello')

    expect(mo.seen).toHaveLength(1)
    expect(readTurns(ws).at(-1)).toMatchObject({ stopReason: 'answer', output: 'done' })
    expect(readEvents(ws, { event: 'schedule_refused' })).toEqual([])
  })
})
