import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createModelServer } from './fixtures/model-server.js'
import { brokerSocketPath } from '../src/infra/broker-socket.js'
import { definitionWith } from '../src/core/identity-defaults.js'
import { readInbox, readTurns } from '../src/core/spore-dir.js'

const run = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const SPORE = resolve(__dirname, '../../spore-cli/bin/spore.js')
const WS = resolve(__dirname, '.spore-cli-workspace')

// Stands in for the provider. The agent asks for the workspace's own environment
// on the first round, so what it holds becomes an artifact on disk.
const scriptedMo = () => {
  let round = 0
  return {
    use: (modelId) => ({
      id: modelId,
      info: () => ({ contextTokenLimit: 200000 }),
      answer: async () => (round++ === 0
        ? { status: 'tool_use', output: '', toolCalls: [{ id: 'c1', name: 'wsexec', arguments: { command: 'env', out: 'data/env.txt' } }], cost: 0.01 }
        : { status: 'completed', output: 'THE ANSWER', cost: 0.01 })
    })
  }
}

// A workspace under the repo is inside a path the sandbox grants, and the runtime refuses to
// confine one there.
const definition = () => definitionWith('anthropic/claude-haiku-4-5').replace('\nmodel: ', '\nunconfined: true\nmodel: ')

let broker

const spore = (args, env = {}) => run(process.execPath, [SPORE, ...args], {
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    MODEL: 'anthropic/claude-haiku-4-5',
    SPORE_MODEL_SOCKET: broker.socketPath,
    ANTHROPIC_API_SK: 'sk-supervisor-secret',
    OPENAI_API_SK: 'sk-supervisor-secret',
    BRAVE_API_SK: 'brave-supervisor-secret',
    ...env
  }
})

beforeEach(async () => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
  writeFileSync(resolve(WS, 'spore.cmk'), definition())
  broker = createModelServer({ mo: scriptedMo(), socketPath: brokerSocketPath('cli-test'), limit: 10 })
  await broker.listen()
})

afterEach(async () => {
  await broker.close()
  rmSync(WS, { recursive: true, force: true })
})

describe('the spore command as two processes', () => {
  it('runs a turn and puts the answer on stdout', async () => {
    const { stdout } = await spore(['send', WS, 'hello'])
    expect(stdout.trim()).toBe('THE ANSWER')
  })

  it('gives the agent no key it could spend with, only the socket', async () => {
    await spore(['send', WS, 'hello'])
    const env = readFileSync(resolve(WS, 'data/env.txt'), 'utf8').split('\n')

    expect(env.some(line => line.startsWith('ANTHROPIC_API_SK'))).toBe(false)
    expect(env.some(line => line.startsWith('OPENAI_API_SK'))).toBe(false)
    expect(env.some(line => line.startsWith(`SPORE_MODEL_SOCKET=${broker.socketPath}`))).toBe(true)
    expect(env.some(line => line.startsWith('MODEL=anthropic/'))).toBe(true)
  })

  it('keeps a key in the runner\'s environment out of the agent\'s, and a source socket it was granted no source for', async () => {
    await spore(['send', WS, 'hello'])
    const given = readFileSync(resolve(WS, 'data/env.txt'), 'utf8').split('\n')
    expect(given.some(line => line.startsWith('BRAVE_API_SK') || line.startsWith('SPORE_SOURCE_SOCKET'))).toBe(false)
  })

  // The turn runs in a process of its own and `spore send` follows its files. Walking
  // away costs the turn nothing, which is the whole reason for the arrangement.
  it('runs the turn detached and follows it, so the answer still lands on stdout', async () => {
    const { stderr } = await spore(['send', WS, 'hello'])

    // The runner's streams, written to the workspace rather than inherited.
    expect(readFileSync(resolve(WS, 'spore.out'), 'utf8')).toContain('THE ANSWER')
    expect(existsSync(resolve(WS, 'spore.err'))).toBe(true)
    expect(stderr).toContain('limits: 40/45 rounds · $0.50/$0.75 · 10/12m')
    expect(readFileSync(resolve(WS, 'spore.err'), 'utf8')).not.toContain('limits:')
  })

  it('puts what was said in the inbox, and records how far the turn read', async () => {
    await spore(['send', WS, 'hello'])

    expect(readInbox(WS).map(entry => entry.text)).toContain('hello')
    const turn = readTurns(WS).at(-1)
    expect(turn.inboxTo).toBe(readInbox(WS).at(-1).inboxNo)
  })

  it('records the model the turn ran on', async () => {
    await spore(['send', WS, 'hello'])
    expect(readTurns(WS).at(-1).model).toBe('anthropic/claude-haiku-4-5')
  })

  it('sends a file with --attach, beside the message, and refuses one it cannot read', async () => {
    const file = resolve(WS, '..', '.spore-cli-staged.diff')
    writeFileSync(file, 'diff --git a/x b/x\n')
    try {
      await spore(['send', WS, 'write the commit message', '--attach', file])
      const entry = readInbox(WS).at(-1)
      expect(entry.text).toBe('write the commit message')
      expect(entry.files).toEqual([expect.objectContaining({ name: '.spore-cli-staged.diff', bytes: 19 })])
      expect(readFileSync(resolve(WS, entry.files[0].path), 'utf8')).toBe('diff --git a/x b/x\n')
    } finally {
      rmSync(file, { force: true })
    }
    await expect(spore(['send', WS, 'again', '--attach', file])).rejects.toMatchObject({ code: 2, stderr: expect.stringMatching(/--attach .* cannot be read/) })
    await expect(spore(['stop', WS, '--attach', file])).rejects.toMatchObject({ code: 2, stderr: expect.stringMatching(/--attach is for send/) })
  })

  it('with --json, prints what was sent, the turn\'s events and its result, one JSON object a line', async () => {
    const { stdout } = await spore(['send', WS, 'hello', '--json'])
    const lines = stdout.trim().split('\n').map(text => JSON.parse(text))
    expect(lines[0]).toEqual({ event: 'sent', inbox: 1, started: true, repeated: false })
    const logged = lines.slice(1, -1)
    expect(logged.every(event => Number.isInteger(event.seq))).toBe(true)
    expect(logged.find(event => event.event === 'complete').output).toBe('THE ANSWER')
    expect(logged.find(event => event.event === 'turn_end')).toMatchObject({ inboxTo: 1, stopReason: 'answer' })
    expect(lines.at(-1)).toMatchObject({ event: 'result', read: true, turn: { turnNo: 1, output: 'THE ANSWER', stopReason: 'answer' } })

    const after = logged.find(event => event.event === 'complete').seq
    const attached = await spore(['attach', WS, '--json', '--after', String(after - 1)])
    const again = attached.stdout.trim().split('\n').map(text => JSON.parse(text))
    expect(again[0]).toMatchObject({ event: 'complete', seq: after })
    expect(again.some(event => event.event === 'turn_end')).toBe(true)
    await expect(spore(['attach', WS, '--json', '--after', 'soon'])).rejects.toMatchObject({ code: 2, stderr: expect.stringMatching(/--after soon is not an event's seq/) })
  })

  it('takes a message once under a request id, and answers a repeat with what the first got', async () => {
    const first = await spore(['send', WS, 'hello', '--request-id', 'order-7'])
    expect(first.stdout.trim()).toBe('THE ANSWER')

    const repeat = await spore(['send', WS, 'hello', '--request-id', 'order-7'])
    expect(repeat.stdout.trim()).toBe('THE ANSWER')
    expect(repeat.stderr).toMatch(/already sent under order-7 — turn 1 answered it/)
    expect(readInbox(WS)).toHaveLength(1)
    expect(readTurns(WS)).toHaveLength(1)

    const asJson = await spore(['send', WS, 'hello', '--request-id', 'order-7', '--json'])
    expect(asJson.stdout.trim().split('\n').map(text => JSON.parse(text))).toEqual([
      { event: 'sent', inbox: 1, started: false, repeated: true },
      expect.objectContaining({ event: 'result', read: true, turn: expect.objectContaining({ turnNo: 1, output: 'THE ANSWER' }) })
    ])
  })

  it('exits 4 when the turn wrapped up at a soft limit, its answer still on stdout', async () => {
    writeFileSync(resolve(WS, 'spore.cmk'), definition().replace('rounds: [40, 45]', 'rounds: [1, 3]'))
    const wrapped = await spore(['send', WS, 'hello']).catch(err => err)
    expect(wrapped.code).toBe(4)
    expect(wrapped.stdout.trim()).toBe('THE ANSWER')
    expect(wrapped.stderr).toMatch(/wrapped up at its rounds limit/)
    expect(readTurns(WS).at(-1).stopReason).toBe('soft:rounds')
  })

  it('exits attach by how the turn ended, as send does, with --json or without', async () => {
    writeFileSync(resolve(WS, 'spore.cmk'), definition().replace('rounds: [40, 45]', 'rounds: [1, 3]'))
    await spore(['send', WS, 'hello']).catch(err => err)
    const [plain, json] = await Promise.all([
      spore(['attach', WS]).catch(err => err),
      spore(['attach', WS, '--json', '--after', '0']).catch(err => err)
    ])
    expect(plain.code).toBe(4)
    expect(plain.stderr).toMatch(/wrapped up at its rounds limit/)
    expect(json.code).toBe(4)
    expect(json.stdout.trim().split('\n').map(text => JSON.parse(text)).find(event => event.event === 'turn_end')).toMatchObject({ stopReason: 'soft:rounds' })
  })

  it('counts the agent\'s own spend where the agent cannot reach it', async () => {
    await spore(['send', WS, 'hello'])
    // Two rounds through the broker, and the agent never touched the total.
    expect(broker.ledger.children).toBeCloseTo(0.02)
  })
})
