import './fixtures/own-config.js'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { answerApproval, askApproval, callApprovalHook, inputsProblem } from '../src/library/approvals.js'
import { readConfig } from '../src/library/config.js'
import { approvalOf, approvalsIn, expireApproval, postApproval, readInbox, refuseApproval, saidOf, settleApproval } from '../src/core/spore-dir.js'
import { send } from '../src/core/send.js'

const ROOT = resolve(tmpdir(), 'spore-approvals-test')
const WS = join(ROOT, 'ws')
const CONFIG = join(ROOT, 'config.json')
const SECRET = '${KPI_HOOK_SECRET}' // eslint-disable-line no-template-curly-in-string

const REQUEST = {
  to: 'telegram:main/42',
  by: ['42'],
  options: [{ id: 'apply', label: 'Apply', style: 'positive' }, { id: 'cancel', label: 'Cancel' }],
  body: { default: { text: 'Apply the new value?', facts: [['Now', '82 %']] } }
}

const ask = (request, options = {}) => askApproval(WS, { ...REQUEST, ...request }, { configFile: CONFIG, ...options })

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
  writeFileSync(CONFIG, JSON.stringify({ approvals: { kpi: { url: 'https://host.example/approved', secret: SECRET } } }))
})
afterEach(() => rmSync(ROOT, { recursive: true, force: true }))

describe('asking an approval', () => {
  it('writes it down for the relay of its place, open for a day unless it says otherwise', () => {
    const now = Date.parse('2026-10-16T14:00:00Z')
    const { approval, until } = ask({ hook: 'kpi' }, { now })
    expect(approval).toMatch(/^[0-9a-f]{12}$/)
    expect(until).toBe('2026-10-17T14:00:00.000Z')
    expect(approvalsIn(WS)).toEqual([expect.objectContaining({
      id: approval,
      place: 'telegram:main/42',
      approvers: ['42'],
      options: REQUEST.options,
      body: REQUEST.body,
      within: '24h',
      calendar: null,
      until,
      hook: 'kpi',
      state: 'asked',
      told: false
    })])
  })

  it('counts working days on its calendar, skipping the weekend and its holidays', () => {
    const friday = Date.parse('2026-12-24T09:00:00Z')
    const calendar = { tz: 'Europe/Paris', holidays: ['2026-12-25'] }
    expect(ask({ within: '1wd', calendar }, { now: friday }).until).toBe('2026-12-28T09:00:00.000Z')
    expect(ask({ within: '2h' }, { now: friday }).until).toBe('2026-12-24T11:00:00.000Z')
    expect(() => ask({ within: '1wd' })).toThrow(/no calendar/)
    expect(() => ask({ within: '2h', calendar })).toThrow(/calendar counts working days/)
    expect(() => ask({ within: '1wd', calendar: { tz: 'Mars/Olympus' } })).toThrow(/not a time zone/)
    expect(() => ask({ within: '1d' })).toThrow(/within it cannot read/)
  })

  it('refuses what cannot be asked or shown, and a hook the host does not name', () => {
    const refused = [
      [{ to: 'terminal' }, /asked nowhere it can be answered/],
      [{ to: 'telegram' }, /asked nowhere it can be answered/],
      [{ by: [] }, /names no one who may answer it/],
      [{ by: ['42', '42'] }, /names no one who may answer it/],
      [{ options: [] }, /offers no choices/],
      [{ options: Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, label: `O${i}` })) }, /offers no choices/],
      [{ options: [{ id: 'a b', label: 'A' }] }, /has a choice it cannot show/],
      [{ options: [{ id: 'a', label: 'x'.repeat(41) }] }, /has a choice it cannot show/],
      [{ options: [{ id: 'a', label: 'A', style: 'green' }] }, /has a choice it cannot show/],
      [{ options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }, /two choices under one id/],
      [{ body: {} }, /shows nothing/],
      [{ body: { Teams: {} } }, /which is no platform/],
      [{ body: { teams: 'card' } }, /is not an object/],
      [{ body: { default: { text: 'x', image: 'y' } } }, /default body it cannot show/],
      [{ body: { default: { facts: [['Now']] } } }, /default body it cannot show/],
      [{ fields: [] }, /has fields it cannot show/],
      [{ fields: Array.from({ length: 6 }, (_, i) => ({ id: `f${i}`, label: `F${i}` })) }, /has fields it cannot show/],
      [{ fields: [{ id: 'a b', label: 'A' }] }, /has a field it cannot show/],
      [{ fields: [{ id: 'a', label: 'Why\nnot?' }] }, /has a field it cannot show/],
      [{ fields: [{ id: 'a', label: 'A', value: 82 }] }, /has a field it cannot show/],
      [{ fields: [{ id: 'a', label: 'A', required: 'yes' }] }, /has a field it cannot show/],
      [{ fields: [{ id: 'a', label: 'A', kind: 'number' }] }, /has a field it cannot show/],
      [{ fields: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }, /two fields under one id/],
      [{ hook: 'billing' }, /calls a hook .* does not name/],
      [{ secret: 'x' }, /has secret, which an approval does not take/]
    ]
    for (const [change, problem] of refused) {
      expect(() => ask(change), JSON.stringify(change)).toThrow(problem)
    }
    expect(approvalsIn(WS)).toEqual([])
  })
})

describe('the fields an approval asks to be filled in', () => {
  const FIELDS = [{ id: 'value', label: 'Value', value: '82 %', required: true }, { id: 'reason', label: 'Why?' }]

  it('are kept with it, and none is null', () => {
    expect(approvalOf(WS, ask({ fields: FIELDS }).approval).fields).toEqual(FIELDS)
    expect(approvalOf(WS, ask({}).approval).fields).toBe(null)
  })

  it('take a press filling in those it declares, as text within the limit, each it requires filled in', () => {
    expect(inputsProblem(FIELDS, { value: '84 %' })).toBe(null)
    expect(inputsProblem(FIELDS, { value: '84 %', reason: '' })).toBe(null)
    expect(inputsProblem(null, null)).toBe(null)
    expect(inputsProblem(FIELDS, null)).toBe('fill in "Value" first')
    expect(inputsProblem(FIELDS, { value: '  ', reason: 'checked' })).toBe('fill in "Value" first')
    expect(inputsProblem(FIELDS, { value: '84 %', comment: 'x' })).toBe('"comment" is not one of its fields')
    expect(inputsProblem(null, { comment: 'x' })).toBe('"comment" is not one of its fields')
    expect(inputsProblem(FIELDS, { value: 84 })).toBe('"Value" takes text of at most 2000 characters')
    expect(inputsProblem(FIELDS, { value: 'x'.repeat(2001) })).toBe('"Value" takes text of at most 2000 characters')
  })
})

describe('an approval as it goes', () => {
  it('takes a press only from someone it names, on one of its choices, with its fields filled in as they must be', () => {
    const { approval } = ask({ fields: [{ id: 'value', label: 'Value', required: true }] }, { now: Date.now() })
    postApproval(WS, approval, { shown: { text: 'Apply?' }, note: 7 })
    const press = (choice, inputs, id) => answerApproval(WS, approval, { choice, inputs, person: { id, name: 'Someone' } })
    expect(press('apply', { value: '84 %' }, '43')).toEqual({ taken: false, reason: 'this is not yours to answer' })
    expect(press('maybe', { value: '84 %' }, '42')).toEqual({ taken: false, reason: 'that is not one of its choices' })
    expect(press('apply', null, '42')).toEqual({ taken: false, reason: 'fill in "Value" first' })
    expect(press('apply', { comment: 'x' }, '42')).toEqual({ taken: false, reason: '"comment" is not one of its fields' })
    expect(approvalOf(WS, approval).state).toBe('posted')
    expect(press('apply', { value: '84 %' }, '42')).toEqual({ taken: true })
    expect(approvalOf(WS, approval)).toMatchObject({ state: 'answered', choice: 'apply', inputs: { value: '84 %' } })
  })

  it('takes no press on an approval nobody asked', () => {
    expect(answerApproval(WS, 'a1b2c3d4e5f6', { choice: 'apply', inputs: null, person: { id: '42', name: 'Ann' } })).toEqual({ taken: false, reason: 'this question is not open here' })
  })

  it('takes one press while it is posted, and is seen through once', () => {
    const { approval } = ask({}, { now: Date.now() })
    expect(answerApproval(WS, approval, { choice: 'apply', inputs: null, person: { id: '42', name: 'Ann' } })).toEqual({ taken: false, reason: 'this question is closed' })
    expect(postApproval(WS, approval, { shown: { text: 'Apply?' }, note: 7 })).toBe(true)
    expect(answerApproval(WS, approval, { choice: 'apply', inputs: null, person: { id: '42', name: 'Ann' } })).toEqual({ taken: true })
    expect(answerApproval(WS, approval, { choice: 'cancel', inputs: null, person: { id: '42', name: 'Ann' } })).toEqual({ taken: false, reason: 'this was answered already' })
    expect(expireApproval(WS, approval)).toBe(false)
    expect(approvalsIn(WS, { open: true }).map(one => one.id)).toEqual([approval])
    expect(settleApproval(WS, approval, { outcome: 'confirmed', replaced: { text: 'done' }, tell: '82 % is in' })).toBe(true)
    expect(approvalOf(WS, approval)).toMatchObject({ state: 'answered', choice: 'apply', inputs: null, note: '7', answererName: 'Ann', outcome: 'confirmed', replaced: { text: 'done' }, tell: '82 % is in', told: false })
    expect(approvalsIn(WS, { open: true }).map(one => one.id)).toEqual([approval])

    send(WS, 'Ann chose "Apply".', { start: false, requestId: `approval:${approval}`, replyTo: 'telegram:main/42', approval, from: { name: 'Ann', id: 'telegram:42', where: 'chat 42 on Telegram' } })
    expect(approvalOf(WS, approval).told).toBe(true)
    expect(approvalsIn(WS, { open: true })).toEqual([])
  })

  it('leaves a refused one open until it is settled, and never as owed to the spore', () => {
    const { approval } = ask({})
    expect(refuseApproval(WS, approval, 'Telegram cannot show it')).toBe(true)
    expect(postApproval(WS, approval, { shown: {}, note: 1 })).toBe(false)
    expect(approvalsIn(WS, { open: true }).map(one => one.id)).toEqual([approval])
    expect(settleApproval(WS, approval)).toBe(true)
    expect(approvalsIn(WS, { open: true })).toEqual([])
    expect(approvalOf(WS, approval)).toMatchObject({ state: 'refused', reason: 'Telegram cannot show it' })
    expect(approvalOf(WS, 'ffffffffffff')).toBe(null)
  })
})

describe('telling the spore', () => {
  it('reads a press as recorded from the buttons, and an expiry as nobody answering, never as words typed', () => {
    const answered = { approval: 'a1b2c3d4e5f6', fromName: 'Ann', fromId: 'telegram:42', fromWhere: 'chat 42 on Telegram', text: 'Ann chose "Apply".' }
    expect(saidOf(answered)).toBe('[Approval a1b2c3d4e5f6, answered by "Ann" (telegram:42) in "chat 42 on Telegram": recorded by the runtime from the platform\'s own buttons, not typed by anyone.]\n\nAnn chose "Apply".')
    expect(saidOf({ approval: 'a1b2c3d4e5f6', text: 'Nobody answered it by 2026-10-17T14:00:00.000Z.' })).toMatch(/^\[Approval a1b2c3d4e5f6, answered by no one before its deadline: /)
  })

  it('needs the conversation it was asked in, and is no schedule\'s, webhook\'s or overheard', () => {
    expect(() => send(WS, 'x', { start: false, approval: 'a1' })).toThrow(/names it, and the conversation it was asked in/)
    expect(() => send(WS, 'x', { start: false, approval: 'a1', replyTo: 'telegram:main/42', schedule: { name: 's', due: 'd' } })).toThrow(/names it, and the conversation/)
    send(WS, 'x', { start: false, approval: 'a1', replyTo: 'telegram:main/42' })
    expect(readInbox(WS)[0]).toMatchObject({ approval: 'a1', replyTo: 'telegram:main/42' })
  })
})

describe('the hook', () => {
  const hookCall = (respond, { env = { KPI_HOOK_SECRET: 'hook-secret' }, retriesMs = [1, 1] } = {}) => {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, ...init })
      return respond(calls.length)
    }
    const done = callApprovalHook('kpi', { approval: 'a1', outcome: 'answered' }, { configFile: CONFIG, env, sleep: async () => {}, signal: new AbortController().signal, fetchImpl, retriesMs })
    return { calls, done }
  }
  const json = (status, body) => new Response(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body), { status })

  it('is told signed, and its answer is what replaces the question and what the spore is told', async () => {
    const { calls, done } = hookCall(() => json(200, { body: { default: { text: 'Done' } }, tell: '82 % is in' }))
    expect(await done).toEqual({ body: { default: { text: 'Done' } }, tell: '82 % is in' })
    const [call] = calls
    expect(call.url).toBe('https://host.example/approved')
    const expected = createHmac('sha256', 'hook-secret').update(`${call.headers['x-spore-timestamp']}.${call.body}`).digest('hex')
    expect(call.headers['x-spore-signature']).toBe(`sha256=${expected}`)
    expect(JSON.parse(call.body)).toEqual({ approval: 'a1', outcome: 'answered' })
  })

  it('is tried again after a 5xx or no answer, and not after a refusal', async () => {
    const flaky = hookCall((n) => n === 1 ? json(503) : json(200))
    expect(await flaky.done).toEqual({})
    expect(flaky.calls).toHaveLength(2)

    const down = hookCall(() => json(500))
    await expect(down.done).rejects.toMatchObject({ type: 'APPROVAL_HOOK_FAILED', detail: 'it answered 500, 3 times' })

    const refusing = hookCall(() => json(409))
    await expect(refusing.done).rejects.toMatchObject({ type: 'APPROVAL_HOOK_FAILED', detail: 'it answered 409' })
    expect(refusing.calls).toHaveLength(1)
  })

  it('fails on an answer spore cannot read, and without its secret', async () => {
    await expect(hookCall(() => json(200, 'yes')).done).rejects.toMatchObject({ detail: expect.stringMatching(/not JSON/) })
    await expect(hookCall(() => json(200, { card: {} })).done).rejects.toMatchObject({ detail: expect.stringMatching(/cannot read/) })
    await expect(hookCall(() => json(200, { body: { default: { image: 'x' } } })).done).rejects.toMatchObject({ detail: expect.stringMatching(/a body spore cannot show — the approval has a default body it cannot show/) })
    const { calls, done } = hookCall(() => json(200), { env: {} })
    await expect(done).rejects.toMatchObject({ detail: expect.stringMatching(/\$KPI_HOOK_SECRET, which is not set/) })
    expect(calls).toEqual([])
  })

  it('is named in config.json by its address and the variable holding its secret', () => {
    const refused = [
      { kpi: 'https://host.example' },
      { kpi: { url: 'ftp://host.example', secret: SECRET } },
      { kpi: { url: 'https://host.example', secret: 'plain' } },
      { kpi: { url: 'https://host.example', secret: SECRET, method: 'PUT' } },
      { 'k p i': { url: 'https://host.example', secret: SECRET } },
      { '-kpi': { url: 'https://host.example', secret: SECRET } },
      { ['k'.repeat(65)]: { url: 'https://host.example', secret: SECRET } }
    ]
    for (const approvals of refused) {
      writeFileSync(CONFIG, JSON.stringify({ approvals }))
      expect(() => readConfig(CONFIG), JSON.stringify(approvals)).toThrow(/approval hook|approvals that is not a map/)
    }
  })
})
