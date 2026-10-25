import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startGate } from './fixtures/model-server.js'
import { calls, answers, scriptedMo } from './fixtures/scripted-model.js'
import { outsideRoot, outsideWorkspace } from './fixtures/outside-ws.js'
import { native } from '../src/native.js'
import { acquireLock, enqueue, heldIn, holdDelivery, readInbox, readTurns, releaseLock, hostState, writeOutcome, writeTurnRecords } from '../src/core/spore-dir.js'
import { RUNNING, stateOf } from '../src/core/state.js'
import { tick, TICK_LOCK } from '../src/core/tick.js'

const SPORE = resolve(dirname(fileURLToPath(import.meta.url)), '../../spore-cli/bin/spore.js')
const EVERY_MINUTE = '---\nwhen: * * * * *\ntz: UTC\n---\n\nCheck the queue.\n'

let ws
let home
let config
let gate
let mo

const env = () => ({ PATH: process.env.PATH, HOME: process.env.HOME })

const until = async (done, limitMs = 15000) => {
  const deadline = Date.now() + limitMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('waited too long')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const settled = () => until(() => stateOf(ws).state !== RUNNING && readTurns(ws).length > 0)

const schedule = (name, source, { ago = 10 * 60_000 } = {}) => {
  mkdirSync(resolve(ws, 'schedules'), { recursive: true })
  const path = resolve(ws, 'schedules', `${name}.cmk`)
  writeFileSync(path, source)
  const then = new Date(Date.now() - ago)
  utimesSync(path, then, then)
}

const start = async (reply) => {
  mo = scriptedMo(reply)
  gate = await startGate({ mo, name: 'tick' })
  gate.configure({ workspaces: [ws] }, config)
}

const pass = (now = Date.now()) => tick({ now, configFile: config, env: env() })

beforeEach(() => {
  ws = outsideWorkspace('tick')
  home = outsideRoot('tick-config')
  config = resolve(home, 'config.json')
  writeFileSync(config, JSON.stringify({ workspaces: [ws] }))
})

afterEach(async () => {
  await gate?.close()
  gate = null
  rmSync(ws, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

describe('a pass', () => {
  it('lets every due delivery go together, in one turn, and only once the spore is free', async () => {
    await start(() => answers('noted both'))
    const at = (ms) => new Date(ms).toISOString()
    const now = Date.now()
    const held = (delivery, releaseAt) => holdDelivery(ws, '', {
      attach: [{ name: 'payload.json', mime: 'application/json', data: Buffer.from('{}') }],
      hook: { name: 'forge', event: 'push', delivery },
      requestId: `webhook:forge:${delivery}`,
      releaseAt: at(releaseAt),
      deadline: at(now + 3_600_000)
    })
    held('d-1', now - 60_000)
    held('d-2', now - 30_000)
    held('d-3', now + 600_000)

    acquireLock(ws)
    expect(pass(now).lines.filter(line => line.state === 'released')).toEqual([])
    releaseLock(ws)

    expect(pass(now).lines).toContainEqual(expect.objectContaining({ ws, state: 'released', deliveries: 2, started: true }))
    await settled()
    expect(readTurns(ws)).toHaveLength(1)
    expect(readInbox(ws).map(entry => entry.hookDelivery)).toEqual(['d-1', 'd-2'])
    expect(heldIn(ws).map(row => JSON.parse(row.entry).hookDelivery)).toEqual(['d-3'])
  })

  it('fires a due schedule once, and the turn is told the clock sent it', async () => {
    await start(() => answers('queue is empty'))
    schedule('queue', EVERY_MINUTE)
    const now = Date.now()

    const first = pass(now)
    expect(first.ran).toBe(true)
    expect(first.lines).toEqual([expect.objectContaining({ ws, name: 'queue', state: 'fired' })])
    await settled()

    const [entry] = readInbox(ws)
    expect(entry).toMatchObject({ schedule: 'queue', due: first.lines[0].slot })
    const prompt = mo.seen[0].filter(m => m.role === 'user').map(m => JSON.stringify(m.content)).join(' ')
    expect(prompt).toContain('Said by the clock: schedule \\"queue\\"')
    expect(prompt).toContain('Check the queue.')

    expect(pass(now).lines).toEqual([expect.objectContaining({ name: 'queue', state: 'later' })])
    expect(readInbox(ws)).toHaveLength(1)
  })

  it('records a turn that had nothing to say as quiet, and leaves the spore free', async () => {
    await start(() => calls('quiet', { because: 'queue unchanged' }))
    schedule('queue', EVERY_MINUTE)
    pass()
    await settled()

    expect(readTurns(ws).at(-1)).toMatchObject({ stopReason: 'quiet', concluded: true, because: 'queue unchanged' })
    expect(stateOf(ws).state).toBe('idle')
  })

  it('fires one schedule per spore per pass', async () => {
    await start(() => answers('done'))
    schedule('a', EVERY_MINUTE)
    schedule('b', EVERY_MINUTE)
    const { lines } = pass()
    expect(lines.map(l => [l.name, l.state, l.why])).toEqual([['a', 'fired', undefined], ['b', 'held', 'running']])
    await settled()
  })

  it('fires once when several passes start together', async () => {
    await start(() => answers('done'))
    schedule('queue', EVERY_MINUTE)
    gate.configure({ workspaces: [ws] }, resolve(home, 'spore', 'config.json'))

    const passes = Array.from({ length: 3 }, () => {
      const child = spawn(process.execPath, [SPORE, 'tick'], {
        env: { ...env(), XDG_CONFIG_HOME: home, XDG_STATE_HOME: process.env.XDG_STATE_HOME },
        stdio: ['ignore', 'pipe', 'inherit']
      })
      let out = ''
      child.stdout.on('data', chunk => { out += chunk })
      return once(child, 'close').then(([code]) => ({ code, lines: out.split('\n').filter(Boolean).map(line => JSON.parse(line)) }))
    })
    const ended = await Promise.all(passes)
    await settled()

    expect(ended.map(e => e.code)).toEqual([0, 0, 0])
    expect(ended.flatMap(e => e.lines).filter(l => l.state === 'fired')).toHaveLength(1)
    expect(readInbox(ws).filter(entry => entry.schedule)).toHaveLength(1)
  })

  it('does nothing while another pass holds the lock', async () => {
    await start(() => answers('done'))
    schedule('queue', EVERY_MINUTE)
    const held = native.hold(TICK_LOCK)
    try {
      expect(pass()).toEqual({ ran: false, lines: [] })
    } finally {
      closeSync(held)
    }
    expect(readInbox(ws)).toHaveLength(0)
  })
})

describe('a pass over a spore that cannot take a new turn', () => {
  const turned = (record) => writeTurnRecords(ws, [{ startedAt: new Date().toISOString(), ...record }])
  const locked = (pid) => writeFileSync(resolve(ws, 'lock'), JSON.stringify({ pid, startedAt: new Date().toISOString() }))

  const gone = async () => {
    const child = spawn(process.execPath, ['-e', ''])
    await once(child, 'close')
    return child.pid
  }

  it.each([
    ['waiting', () => turned({ stopReason: 'question', concluded: true })],
    ['failed', () => turned({ stopReason: 'error', concluded: false })],
    ['running', () => acquireLock(ws)],
    ['draining', () => { acquireLock(ws); writeOutcome(hostState(ws), { stopReason: 'answer' }) }],
    ['crashed', async () => locked(await gone())]
  ])('holds its schedule while it is %s, and says so', async (why, arrange) => {
    await arrange()
    try {
      schedule('queue', EVERY_MINUTE)
      expect(pass().lines).toEqual([expect.objectContaining({ ws, name: 'queue', state: 'held', why })])
      expect(readInbox(ws)).toHaveLength(0)
    } finally {
      releaseLock(ws)
    }
  })

  it('refuses a hand-written file it cannot read, and names it', () => {
    schedule('broken', '---\nwhen: sometimes\ntz: UTC\n---\nx\n')
    expect(pass().lines).toEqual([expect.objectContaining({ name: 'broken', state: 'refused', why: expect.stringMatching(/not a cron expression/) })])
  })
})

describe('a dream', () => {
  const dreaming = () => {
    const cmk = resolve(ws, 'spore.cmk')
    writeFileSync(cmk, readFileSync(cmk, 'utf8').replace(/\nmodel: .*\n/, (line) => `${line}dream: [1, 1m]\ndream.cost: [0.10, 0.20]\ndream.wall: [1m, 2m]\ndream.precursor: tidy\n`))
    const ended = new Date(Date.now() - 10 * 60_000).toISOString()
    writeTurnRecords(ws, [{ startedAt: ended, endedAt: ended, stopReason: 'answer', concluded: true }])
  }
  const said = () => {
    const err = resolve(ws, 'spore.err')
    return existsSync(err) ? readFileSync(err, 'utf8') : ''
  }

  it('starts through its runner when due, which looks again under the lock and lets go', async () => {
    dreaming()
    expect(pass().lines).toEqual([{ ws, state: 'dreaming' }])
    await until(() => said().includes('the dream did not start'))
    await until(() => stateOf(ws).state !== RUNNING)
    expect(said()).toContain('precursors/tidy.cmk is not there')
    expect(readTurns(ws)).toHaveLength(1)
  })

  it('leaves what is said meanwhile to a turn under the same lock, once the dream ends', async () => {
    await start(() => answers('still here'))
    dreaming()
    expect(pass().lines).toEqual([{ ws, state: 'dreaming' }])
    enqueue(ws, 'are you there?')
    await until(() => readTurns(ws).length === 2)
    await until(() => stateOf(ws).state !== RUNNING)
    expect(readTurns(ws)[1]).toMatchObject({ stopReason: 'answer', output: 'still here' })
    expect(readInbox(ws).every(entry => entry.consumed)).toBe(true)
  })

  it('is not due while something said waits unread, nor for a spore that declares none', () => {
    dreaming()
    enqueue(ws, 'hello')
    expect(pass().lines.filter(line => line.state === 'dreaming')).toEqual([])
    writeFileSync(resolve(ws, 'spore.cmk'), readFileSync(resolve(ws, 'spore.cmk'), 'utf8').replace(/dream[^\n]*\n/g, ''))
    expect(pass().lines.filter(line => line.state === 'dreaming')).toEqual([])
  })
})
