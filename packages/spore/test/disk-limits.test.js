/**
 * The machine's disk bounds, from the host's config file through `spore send` to the runner:
 * a file past `largestFile` stops growing, and a turn started under `freeFloor` never starts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createModelServer } from './fixtures/model-server.js'
import { answers, calls, scriptedMo } from './fixtures/scripted-model.js'
import { outsideRoot, outsideWorkspace } from './fixtures/outside-ws.js'
import { brokerSocketPath } from '../src/infra/broker-socket.js'
import { callRuns, readCalls } from '../src/core/call-record.js'
import { readInbox, readTurns } from '../src/core/spore-dir.js'

const run = promisify(execFile)
const SPORE = resolve(dirname(fileURLToPath(import.meta.url)), '../../spore-cli/bin/spore.js')

let ws
let home
let broker
let mo

const configure = (settings) => {
  mkdirSync(resolve(home, 'spore'), { recursive: true })
  writeFileSync(resolve(home, 'spore', 'config.json'), JSON.stringify(settings))
}

const spore = async (prompt) => {
  try {
    const { stdout, stderr } = await run(process.execPath, [SPORE, 'send', ws, prompt], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        XDG_STATE_HOME: process.env.XDG_STATE_HOME,
        XDG_CONFIG_HOME: home,
        SPORE_MODEL_SOCKET: broker.socketPath
      }
    })
    return { code: 0, stdout, stderr }
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr }
  }
}

const start = async (reply) => {
  mo = scriptedMo(reply)
  broker = createModelServer({ mo, socketPath: brokerSocketPath('disk-limits'), limit: 10 })
  await broker.listen()
}

beforeEach(() => {
  ws = outsideWorkspace('disk-limits')
  home = outsideRoot('disk-config')
})

afterEach(async () => {
  await broker?.close()
  broker = null
  rmSync(ws, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

describe('the largest file a turn may write', () => {
  it('stops a file at the cap the host set, and the call says it failed', async () => {
    configure({ largestFile: '1MB' })
    await start(async (input, round) => round === 0
      ? calls('wsexec', { command: 'head -c 3000000 /dev/zero > data/big', out: 'data/log.txt' })
      : answers('tried'))

    const result = await spore('write a big file')
    expect(result.code, result.stderr).toBe(0)
    expect(statSync(resolve(ws, 'data/big')).size).toBeLessThanOrEqual(1024 * 1024)
    const [record] = readCalls(ws, callRuns(ws)[0]).map(entry => entry.record)
    expect(record.tool).toBe('wsexec')
    expect(record.exit).not.toBe(0)
  })
})

describe('the free space a turn needs', () => {
  it('records the turn as DISK_FULL without starting the agent, and keeps its message', async () => {
    configure({ freeFloor: '999999GB' })
    await start(async () => answers('should not be asked'))

    const result = await spore('hello')
    expect(result.code).not.toBe(0)
    expect(mo.seen).toHaveLength(0)
    const [turn] = readTurns(ws)
    expect(turn).toMatchObject({ stopReason: 'error', error: 'DISK_FULL', concluded: false })
    expect(turn.detail).toMatch(/under the \d+ MB floor/)
    expect(readInbox(ws).map(entry => [entry.text, entry.consumed])).toEqual([['hello', false]])
  })
})
