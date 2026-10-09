/**
 * The batch scheduler, against workspaces that do as they are told.
 *
 * Delivery is injected: a message lands in the inbox the way `send` puts it there, and a
 * turn is recorded when the test says it ends. The clock is the test's too, so an errand that
 * never finishes reaches its deadline without anyone waiting for it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runBatch } from '../src/core/batch.js'
import { SporeError } from '../src/observability/errors.js'
import { acquireLock, appendInbox, appendTurn, readInbox, releaseLock } from '../src/core/spore-dir.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '.batch-workspaces')

const errand = (ws, messages, label = 'x') => ({ ws, messages, label, id: label })

// A turn that answered everything said so far, as a runner would record it.
const turn = (ws, record = {}) => appendTurn(ws, {
  startedAt: new Date().toISOString(),
  concluded: true,
  stopReason: 'answer',
  ownMicros: 10_000,
  inboxTo: readInbox(ws).at(-1).inboxNo,
  ...record
})

const said = (ws, message, { requestId }) => appendInbox(ws, message, { requestId })

// What `send` answers when it started a runner for the message.
const STARTED = { started: true }

function workspaces (n) {
  return Array.from({ length: n }, (_, i) => {
    const ws = join(ROOT, `w${i}`)
    mkdirSync(ws, { recursive: true })
    return ws
  })
}

// A clock the test moves, and a bound on how often the loop may wait before it has
// plainly stopped honouring its deadline.
function clock (step = 1000, most = 500) {
  let at = 0
  let calls = 0
  return {
    now: () => at,
    wait: async () => {
      if (++calls > most) throw new Error(`waited ${calls} times — the loop is not honouring its deadline`)
      at += step
    }
  }
}

beforeEach(() => rmSync(ROOT, { recursive: true, force: true }))
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('runBatch', () => {
  it('runs every workspace, never more than atOnce at a time', async () => {
    const out = []
    let most = 0
    const deliver = (ws, message, opts) => { said(ws, message, opts); out.push(ws); most = Math.max(most, out.length); return STARTED }
    const { now, wait } = clock()
    const finishOne = async (ms) => { const ws = out.shift(); if (ws) turn(ws); await wait(ms) }
    const errands = workspaces(5).map(ws => errand(ws, ['go'], ws))
    const { stuck } = await runBatch(errands, { atOnce: 2, deliver, now, wait: finishOne })
    expect(stuck).toEqual([])
    expect(most).toBeLessThanOrEqual(2)
  })

  it('sends an errand its messages in order, the next only once the last turn has ended', async () => {
    const [ws] = workspaces(1)
    const sent = []
    const deliver = (w, message, opts) => { said(w, message, opts); sent.push(message); turn(w); return STARTED }
    const { now, wait } = clock()
    await runBatch([errand(ws, ['one', 'two', 'three'])], { deliver, now, wait })
    expect(sent).toEqual(['one', 'two', 'three'])
  })

  it('carries on where it stopped, sending nothing twice', async () => {
    const [a, b] = workspaces(2)
    appendInbox(a, 'one', { requestId: 'errand:a:0' })
    turn(a)
    const sent = []
    const deliver = (w, message, opts) => { said(w, message, opts); sent.push([w, message]); turn(w); return STARTED }
    const { now, wait } = clock()
    await runBatch([errand(a, ['one', 'two'], 'a'), errand(b, ['one'], 'b')], { deliver, now, wait })
    expect(sent).toEqual([[a, 'two'], [b, 'one']])
  })

  it('does not take what a spore was told before as this errand\'s progress', async () => {
    const [ws] = workspaces(1)
    appendInbox(ws, 'something earlier')
    turn(ws)
    const sent = []
    const deliver = (w, message, opts) => { said(w, message, opts); sent.push(message); turn(w); return STARTED }
    const { now, wait } = clock()
    const { stuck } = await runBatch([errand(ws, ['the new work'])], { deliver, now, wait })
    expect(stuck).toEqual([])
    expect(sent).toEqual(['the new work'])
  })

  it('counts a message a turn read beside another as ended', async () => {
    const [ws] = workspaces(1)
    const sent = []
    const deliver = (w, message, opts) => {
      said(w, message, opts)
      sent.push(message)
      appendInbox(w, 'said from elsewhere meanwhile')
      turn(w)
      return STARTED
    }
    const { now, wait } = clock()
    const { stuck } = await runBatch([errand(ws, ['one', 'two'])], { deliver, now, wait })
    expect(stuck).toEqual([])
    expect(sent).toEqual(['one', 'two'])
  })

  it('takes a message a failed start never read as ended, and sends the next', async () => {
    const [ws] = workspaces(1)
    const sent = []
    const deliver = (w, message, opts) => {
      said(w, message, opts)
      sent.push(message)
      if (message === 'one') turn(w, { stopReason: 'error', error: 'START_FAILED', concluded: false, inboxTo: undefined })
      else turn(w)
      return STARTED
    }
    const { now, wait } = clock()
    const { stuck } = await runBatch([errand(ws, ['one', 'two'])], { deliver, now, wait })
    expect(stuck).toEqual([])
    expect(sent).toEqual(['one', 'two'])
    expect(readInbox(ws).map(entry => [entry.text, entry.consumed])).toEqual([['one', true], ['two', true]])
  })

  it('starts a message an interrupted batch said and never started, without saying it twice', async () => {
    const [ws] = workspaces(1)
    appendInbox(ws, 'one', { requestId: 'errand:x:0' })
    const sent = []
    const deliver = (w, message, opts) => { said(w, message, opts); sent.push(message); turn(w); return STARTED }
    const { now, wait } = clock()
    const { stuck } = await runBatch([errand(ws, ['one'])], { deliver, now, wait })
    expect(stuck).toEqual([])
    expect(sent).toEqual(['one'])
    expect(readInbox(ws).map(entry => entry.text)).toEqual(['one'])
  })

  it('starts again a message refused a slot after it was said', async () => {
    const [ws] = workspaces(1)
    const events = []
    let refused = false
    const deliver = (w, message, opts) => {
      said(w, message, opts)
      if (!refused) {
        refused = true
        throw new SporeError('full', { type: 'ADMISSION_FULL' })
      }
      turn(w)
      return STARTED
    }
    const { now, wait } = clock()
    const { stuck } = await runBatch([errand(ws, ['go'])], { deliver, now, wait, report: (e) => events.push(e.event) })
    expect(stuck).toEqual([])
    expect(events).toEqual(['full', 'started', 'ended'])
  })

  it('waits on a message it started whose runner has not taken the lock yet', async () => {
    const [ws] = workspaces(1)
    let delivered = 0
    let waits = 0
    const deliver = (w, message, opts) => { said(w, message, opts); delivered++; return STARTED }
    const { now, wait } = clock()
    const later = async (ms) => { if (++waits === 3) turn(ws); await wait(ms) }
    const { stuck } = await runBatch([errand(ws, ['go'])], { deliver, now, wait: later })
    expect(stuck).toEqual([])
    expect(delivered).toBe(1)
  })

  it('starts again a message a running turn was stopped before reading', async () => {
    const [ws] = workspaces(1)
    let deliveries = 0
    let waits = 0
    const deliver = (w, message, opts) => {
      said(w, message, opts)
      if (++deliveries === 1) {
        acquireLock(w)
        return { started: false }
      }
      turn(w)
      return STARTED
    }
    const { now, wait } = clock()
    const stopped = async (ms) => {
      if (++waits === 2) {
        releaseLock(ws)
        appendTurn(ws, { startedAt: '2026-01-01T00:00:00.000Z', concluded: false, stopReason: 'cancelled', ownMicros: 0 })
      }
      await wait(ms)
    }
    const { stuck } = await runBatch([errand(ws, ['go'])], { deliver, now, wait: stopped })
    expect(stuck).toEqual([])
    expect(deliveries).toBe(2)
  })

  it('refuses an errand with no id, which is what makes a batch resumable', async () => {
    const [ws] = workspaces(1)
    await expect(runBatch([{ ws, messages: ['go'], label: 'x' }], { deliver: () => {} })).rejects.toThrow(expect.objectContaining({ type: 'BATCH_USAGE' }))
  })

  it('tries a refused start again on its next poll', async () => {
    const [ws] = workspaces(1)
    const events = []
    let refusals = 2
    const deliver = (w, message, opts) => {
      if (refusals-- > 0) throw new SporeError('full', { type: 'ADMISSION_FULL' })
      said(w, message, opts)
      turn(w)
      return STARTED
    }
    const { now, wait } = clock()
    const { stuck } = await runBatch([errand(ws, ['go'])], { deliver, now, wait, report: (e) => events.push(e.event) })
    expect(stuck).toEqual([])
    expect(events).toEqual(['full', 'full', 'started', 'ended'])
  })

  it('lets any other failure to start end the batch', async () => {
    const [ws] = workspaces(1)
    const deliver = () => { throw new SporeError('broken', { type: 'SOMETHING_ELSE' }) }
    const { now, wait } = clock()
    await expect(runBatch([errand(ws, ['go'])], { deliver, now, wait })).rejects.toThrow('broken')
  })

  it('takes an errand whose runner died as ended, and does not send it again', async () => {
    const [ws] = workspaces(1)
    let sent = 0
    const deliver = (w, message, opts) => {
      said(w, message, opts)
      sent++
      writeFileSync(join(w, 'lock'), JSON.stringify({ pid: 2 ** 22 + 7, startedAt: 'then' }))
      return STARTED
    }
    const { now, wait } = clock()
    const { stuck, ended } = await runBatch([errand(ws, ['one', 'two'])], { deliver, now, wait })
    expect(stuck).toEqual([])
    expect(sent).toBe(1)
    expect(ended).toMatchObject([{ crashed: true, turns: [] }])
  })

  it('hands back what never finished once the deadline passes, instead of waiting on it', async () => {
    const [done, hung] = workspaces(2)
    const deliver = (w, message, opts) => { said(w, message, opts); if (w === done) turn(w); return STARTED }
    const { now, wait } = clock(1000)
    const { stuck } = await runBatch([errand(done, ['go'], 'done'), errand(hung, ['go'], 'hung')], { deliver, now, wait, deadline: 10_000 })
    expect(stuck.map(one => one.label)).toEqual(['hung'])
  })

  it('reports each errand starting and ending', async () => {
    const [ws] = workspaces(1)
    const events = []
    const deliver = (w, message, opts) => { said(w, message, opts); turn(w); return STARTED }
    const { now, wait } = clock()
    await runBatch([errand(ws, ['go'])], { deliver, now, wait, report: e => events.push(e) })
    expect(events).toEqual([{ event: 'started', errand: 'x', message: 0 }, { event: 'ended', errand: 'x', turnNo: 1, stopReason: 'answer' }])
  })

  it('ends an errand with its own turns, not with a turn another sender started after them', async () => {
    const [ws] = workspaces(1)
    const events = []
    const deliver = (w, message, opts) => {
      said(w, message, opts)
      turn(w)
      appendInbox(w, 'said from elsewhere afterwards')
      turn(w, { stopReason: 'soft:rounds' })
      return STARTED
    }
    const { now, wait } = clock()
    const { ended } = await runBatch([errand(ws, ['one', 'two'])], { deliver, now, wait, report: e => events.push(e) })
    expect(ended[0].turns.map(t => [t.turnNo, t.stopReason])).toEqual([[1, 'answer'], [3, 'answer']])
    expect(events.at(-1)).toEqual({ event: 'ended', errand: 'x', turnNo: 3, stopReason: 'answer' })
  })

  it('sends the next message after a runner died on another sender\'s turn', async () => {
    const [ws] = workspaces(1)
    const sent = []
    const deliver = (w, message, opts) => {
      writeFileSync(join(w, 'lock'), '')
      said(w, message, opts)
      sent.push(message)
      turn(w)
      appendInbox(w, 'said from elsewhere afterwards')
      writeFileSync(join(w, 'lock'), JSON.stringify({ pid: 2 ** 22 + 7, startedAt: 'then' }))
      return STARTED
    }
    const { now, wait } = clock()
    const { stuck, ended } = await runBatch([errand(ws, ['one', 'two'])], { deliver, now, wait })
    expect(stuck).toEqual([])
    expect(sent).toEqual(['one', 'two'])
    expect(ended[0].crashed).toBeUndefined()
  })
})
