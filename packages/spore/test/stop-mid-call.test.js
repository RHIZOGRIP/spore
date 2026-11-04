import './fixtures/own-config.js'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { startGate } from './fixtures/model-server.js'
import { outsideWorkspace } from './fixtures/outside-ws.js'
import { marksOf } from '../src/core/marks.js'
import { outbox, readInbox, readTranscript, readTurns, statePath } from '../src/core/spore-dir.js'
import { send } from '../src/core/send.js'
import { RUNNING, interrupt, stateOf, stop } from '../src/core/state.js'

let ws
let gate
let asked
let open
let waiting
let prompts

// Ends the call that is waiting, and lets every later one through: a stopped turn's runner reads
// the call it stopped during to its end before it writes the turn down.
const release = () => {
  open = true
  waiting?.()
}

const env = () => ({ PATH: process.env.PATH, HOME: process.env.HOME })

const held = () => ({
  use: (modelId) => ({
    id: modelId,
    info: () => ({ contextTokenLimit: 200000 }),
    answer: async (prompt) => {
      asked += 1
      prompts.push(JSON.stringify(prompt))
      if (!open) await new Promise(resolve => { waiting = resolve })
      return { status: 'completed', output: 'late', cost: 0.01 }
    }
  })
})

const tail = (file) => (existsSync(join(ws, file)) ? readFileSync(join(ws, file), 'utf8').slice(-1500) : null)

const shown = () => {
  const db = new DatabaseSync(statePath(ws), { readOnly: true })
  try {
    return JSON.stringify({
      rows: db.prepare('SELECT state, stopReason, inboxTo, error, detail FROM t_turns ORDER BY rowid').all(),
      consumed: db.prepare('SELECT inboxConsumed FROM t_workspace').get(),
      state: stateOf(ws).state,
      err: tail('spore.err'),
      out: tail('spore.out')
    })
  } finally {
    db.close()
  }
}

const until = async (done, limitMs = 15000) => {
  const deadline = Date.now() + limitMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`waited too long — ${shown()}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const unread = () => readInbox(ws, { after: readTurns(ws).at(-1)?.inboxTo ?? 0 }).map(entry => entry.text)

const notes = () => readTranscript(ws).filter(message => marksOf(message).includes('stopped'))

const fates = () => readInbox(ws).map(entry => [entry.text, entry.setAside])

const releasedLater = () => new Promise(resolve => setTimeout(() => { release(); resolve() }, 300))

const turnsEnded = (n) => until(() => readTurns(ws).length === n && stateOf(ws).state !== RUNNING)

beforeEach(async () => {
  asked = 0
  open = false
  waiting = null
  prompts = []
  ws = outsideWorkspace('stop-mid-call')
  gate = await startGate({ mo: held(), name: 'stop-mid-call' })
})

afterEach(async () => {
  release()
  if (stateOf(ws).state === RUNNING) stop(ws)
  await until(() => stateOf(ws).state !== RUNNING, 20_000)
  await gate.close()
  rmSync(ws, { recursive: true, force: true })
})

describe.each([true, false])('a turn stopped while its model call is still open, contained: %s', (contain) => {
  beforeEach(() => {
    gate.configure({ contain })
  })

  const relayed = (n) => ({ replyTo: 'telegram:triage/1', from: { name: 'U1 (@u1)', id: 'telegram:1', where: 'a private chat on Telegram' }, requestId: `telegram:triage:${n}` })

  const stopped = async (releasing, { said = () => ({}), endings = ['cancelled'] } = {}) => {
    expect(send(ws, 'first', { env: env(), ...said(1) }).started).toBe(true)
    await until(() => asked === 1)
    expect(send(ws, 'second', { env: env(), ...said(2) }).started).toBe(false)
    expect(stop(ws).stopped).toBe(true)
    await releasing()
    await until(() => readTurns(ws).length === 1 && stateOf(ws).state !== RUNNING)
    const [turn] = readTurns(ws)
    expect(endings, shown()).toContain(turn.stopReason)
    expect(turn.inboxTo).toBe(1)
    expect(unread()).toEqual(['second'])
    expect(notes()).toHaveLength(turn.stopReason === 'cancelled' ? 1 : 0)
  }

  it('is written down as cancelled, having read what it read, when the call ends after the stop', async () => {
    await stopped(() => new Promise(resolve => setTimeout(() => { release(); resolve() }, 300)))
  })

  it('is written down, having read what it read, when the call ends as it is stopped — cancelled or answered, whichever came first', async () => {
    await stopped(async () => release(), { endings: ['cancelled', 'answer'] })
  })

  it('is written down so for a relay, its answer addressed to where it was asked from', async () => {
    await stopped(() => new Promise(resolve => setTimeout(() => { release(); resolve() }, 300)), { said: relayed })
    expect(outbox(ws).map(entry => [entry.recipient, entry.answers])).toEqual([['telegram:triage/1', [1]]])
  })

  it('is written down so for a relay when the call ends as it is stopped', async () => {
    await stopped(async () => release(), { said: relayed, endings: ['cancelled', 'answer'] })
  })

  it('is written down as cancelled, never left as a crash, when the stop lands as its runner starts', async () => {
    expect(send(ws, 'first', { env: env() }).started).toBe(true)
    const deadline = Date.now() + 15000
    while (stateOf(ws).state !== RUNNING) {
      if (Date.now() > deadline) throw new Error(`never running — ${shown()}`)
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(stop(ws).stopped).toBe(true)
    release()
    await until(() => readTurns(ws).length === 1 && stateOf(ws).state !== RUNNING)
    expect([stateOf(ws).state, readTurns(ws)[0].stopReason], shown()).toEqual(['cancelled', 'cancelled'])
  })

  it('leaves a note the next turn reads after what was stopped and before its own message', async () => {
    send(ws, 'the-stopped-work', { env: env() })
    await until(() => asked === 1)
    expect(stop(ws)).toMatchObject({ stopped: true, marked: true })
    await releasedLater()
    await turnsEnded(1)
    expect(readTurns(ws)[0].stopReason, shown()).toBe('cancelled')
    expect(send(ws, 'the-next-thing', { env: env() }).started).toBe(true)
    await turnsEnded(2)
    const seen = prompts.at(-1)
    const [work, note, next] = ['the-stopped-work', 'stopped on request', 'the-next-thing'].map(said => seen.indexOf(said))
    expect(work, seen).toBeGreaterThan(-1)
    expect(note, seen).toBeGreaterThan(work)
    expect(next, seen).toBeGreaterThan(note)
  })

  it('sets aside what the conversation that stopped it queued, and nobody else\'s', async () => {
    send(ws, 'first', { env: env(), ...relayed(1) })
    await until(() => asked === 1)
    send(ws, 'mine', { env: env(), ...relayed(2) })
    send(ws, 'theirs', { env: env(), ...relayed(3), replyTo: 'telegram:triage/2' })
    send(ws, 'nobody\'s', { env: env() })
    stop(ws, { replyTo: 'telegram:triage/1' })
    await releasedLater()
    await turnsEnded(1)
    expect(fates(), shown()).toEqual([['first', false], ['mine', true], ['theirs', false], ['nobody\'s', false]])
  })

  it('with no conversation named, sets aside what was said with none, and no conversation\'s', async () => {
    send(ws, 'first', { env: env() })
    await until(() => asked === 1)
    send(ws, 'queued', { env: env() })
    send(ws, 'theirs', { env: env(), ...relayed(2) })
    stop(ws)
    await releasedLater()
    await turnsEnded(1)
    expect(fates(), shown()).toEqual([['first', false], ['queued', true], ['theirs', false]])
  })

  it('gives what is said after the stop a turn, with nothing more sent', async () => {
    send(ws, 'first', { env: env() })
    await until(() => asked === 1)
    stop(ws)
    expect(send(ws, 'after', { env: env() }).started).toBe(false)
    await releasedLater()
    await turnsEnded(2)
    expect(readTurns(ws).map(turn => turn.stopReason), shown()).toEqual(['cancelled', 'answer'])
    expect(fates()).toEqual([['first', false], ['after', false]])
  })

  it('is not stopped twice by a second stop while it waits on its call, so the turn after it runs', async () => {
    send(ws, 'first', { env: env() })
    await until(() => asked === 1)
    stop(ws)
    await until(() => stateOf(ws).draining === true)
    expect(stop(ws)).toMatchObject({ stopped: true, marked: true })
    send(ws, 'after', { env: env() })
    release()
    await turnsEnded(2)
    expect(readTurns(ws).map(turn => turn.stopReason), shown()).toEqual(['cancelled', 'answer'])
  })

  it.each([
    ['a signal from outside', () => process.kill(stateOf(ws).pid, 'SIGTERM')],
    ['a stop nobody asked of this spore', () => interrupt(ws)]
  ])('after %s, leaves no note, sets nothing aside and starts no turn', async (_, signalled) => {
    send(ws, 'first', { env: env() })
    await until(() => asked === 1)
    send(ws, 'second', { env: env() })
    signalled()
    await releasedLater()
    await turnsEnded(1)
    expect(readTurns(ws)[0].stopReason, shown()).toBe('cancelled')
    expect(notes()).toEqual([])
    expect(fates()).toEqual([['first', false], ['second', false]])
  })
})
