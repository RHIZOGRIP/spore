/**
 * A workspace database held by another writer past the 5 s busy timeout. Nothing may pass
 * for success: `send` refuses, and a turn that can write nothing down says why in `spore.err`
 * and is written down by the next runner, its message still unread.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { createModelServer } from './fixtures/model-server.js'
import { answers, scriptedMo } from './fixtures/scripted-model.js'
import { outsideWorkspace } from './fixtures/outside-ws.js'
import { brokerSocketPath } from '../src/infra/broker-socket.js'
import { appendInbox, readInbox, readTurns, statePath } from '../src/core/spore-dir.js'
import { send } from '../src/core/send.js'
import { RUNNING, stateOf } from '../src/core/state.js'

let ws
let broker
let reply
let held = null

const env = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, SPORE_MODEL_SOCKET: broker.socketPath })

const until = async (done, limitMs = 15000) => {
  const deadline = Date.now() + limitMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('waited too long')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

// Another process, because file locks are a process's: two SQLite builds in one process, as
// the test's and the addon's are, do not see each other's.
const HOLDER = `
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(process.argv[1])
db.exec('BEGIN IMMEDIATE')
process.stdout.write('held\\n')
process.stdin.on('end', () => { db.exec('ROLLBACK'); db.close(); process.exit(0) })
process.stdin.resume()
`

const hold = async () => {
  const child = spawn(process.execPath, ['-e', HOLDER, statePath(ws)], { stdio: ['pipe', 'pipe', 'inherit'] })
  await once(child.stdout, 'data')
  held = child
}
const release = async () => {
  if (!held) return
  const child = held
  held = null
  child.stdin.end()
  await once(child, 'exit')
}

beforeEach(async () => {
  ws = outsideWorkspace('busy-database')
  reply = async () => answers('hello back')
  broker = createModelServer({ mo: scriptedMo((...args) => reply(...args)), socketPath: brokerSocketPath('busy-db'), limit: 10 })
  await broker.listen()
})

afterEach(async () => {
  await release()
  await until(() => stateOf(ws).state !== RUNNING, 60_000)
  await broker.close()
  rmSync(ws, { recursive: true, force: true })
}, 70_000)

describe('a database another writer holds past the timeout', () => {
  it('refuses a send, and writes nothing', async () => {
    appendInbox(ws, 'before')
    await hold()
    const started = Date.now()
    expect(() => send(ws, 'hello', { env: env() })).toThrow(expect.objectContaining({ type: 'INBOX_UNWRITABLE', detail: expect.stringMatching(/locked/) }))
    expect(Date.now() - started).toBeGreaterThanOrEqual(4500)
    await release()
    expect(readInbox(ws).map(entry => entry.text)).toEqual(['before'])
  }, 20_000)

  it('leaves a turn that can write nothing down to the next runner, its message unread', async () => {
    let holding = true
    reply = async () => {
      if (holding) {
        holding = false
        await hold()
      }
      return answers('hello back')
    }
    send(ws, 'first', { env: env() })
    await until(() => held !== null)
    await until(() => stateOf(ws).state !== RUNNING, 60_000)

    expect(readFileSync(join(ws, 'spore.err'), 'utf8')).toMatch(/database is locked/)
    expect(readTurns(ws)).toEqual([])
    await release()

    send(ws, 'second', { env: env() })
    await until(() => readTurns(ws).length === 2 && stateOf(ws).state !== RUNNING)
    const [first, second] = readTurns(ws)
    expect(first).toMatchObject({ turnNo: 1, stopReason: 'error', concluded: false })
    expect(second).toMatchObject({ turnNo: 2, stopReason: 'answer', inboxFrom: 0, inboxTo: 2 })
  }, 70_000)
})
