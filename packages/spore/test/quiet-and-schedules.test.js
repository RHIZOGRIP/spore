import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeTools } from '../src/tools/make-tools.js'
import { runSpore } from '../src/core/spore-run.js'
import { createCallTrail, readCall } from '../src/core/call-record.js'
import { enqueue, hostState, readEvents, readPending } from '../src/core/spore-dir.js'
import { textOf } from '../src/core/message.js'
import { shownToModel } from './fixtures/as-shown.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.quiet-and-schedules-workspace')

const HOURLY = '---\nwhen: 0 * * * *\ntz: UTC\n---\n\nCheck the queue.\n'
const EVERY_FIVE = '---\nwhen: */5 * * * *\ntz: UTC\n---\n\nCheck the queue.\n'
const GRANT = { count: 1, interval: 3_600_000 }

const tools = (options) => shownToModel(makeTools(WS, 50000, createCallTrail(WS, { runId: 'test', state: hostState(WS) }), options).fns)

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
})

afterEach(() => {
  rmSync(WS, { recursive: true, force: true })
})

describe('schedules/ without a grant', () => {
  it('is the operator\'s, and write says so', async () => {
    const { write } = tools()
    expect(await write({ path: 'schedules/queue.cmk', content: HOURLY })).toMatch(/grants no schedules/)
    expect(existsSync(resolve(WS, 'schedules/queue.cmk'))).toBe(false)
  })
})

describe('schedules/ under a grant', () => {
  it('takes a schedule within it', async () => {
    const { write } = tools({ schedules: GRANT })
    expect(JSON.parse(await write({ path: 'schedules/queue.cmk', content: HOURLY })).exit).toBe(0)
    expect(readFileSync(resolve(WS, 'schedules/queue.cmk'), 'utf8')).toBe(HOURLY)
  })

  it('refuses one that fires too often, one too many, and one that does not parse', async () => {
    const { write } = tools({ schedules: GRANT })
    expect(await write({ path: 'schedules/queue.cmk', content: EVERY_FIVE })).toMatch(/5m apart at its closest/)
    expect(await write({ path: 'schedules/queue.cmk', content: '---\nwhen: 0 * * * *\n---\nx\n' })).toMatch(/no tz/)
    await write({ path: 'schedules/queue.cmk', content: HOURLY })
    expect(await write({ path: 'schedules/other.cmk', content: HOURLY })).toMatch(/would make 2 schedules/)
    expect(existsSync(resolve(WS, 'schedules/other.cmk'))).toBe(false)
  })

  it('checks an edit as the file would be after it', async () => {
    const { write, edit } = tools({ schedules: GRANT })
    await write({ path: 'schedules/queue.cmk', content: HOURLY })
    expect(await edit({ path: 'schedules/queue.cmk', old: 'when: 0 * * * *', new: 'when: */5 * * * *' })).toMatch(/5m apart at its closest/)
    expect(readFileSync(resolve(WS, 'schedules/queue.cmk'), 'utf8')).toBe(HOURLY)
    expect(JSON.parse(await edit({ path: 'schedules/queue.cmk', old: 'Check the queue.', new: 'Check both queues.' })).exit).toBe(0)
  })
})

describe('quiet as a tool', () => {
  it('answers with its reason and leaves a record', async () => {
    const { quiet } = tools()
    expect(await quiet({ because: 'no change since 09-26' })).toBe('no change since 09-26')
    const meta = readCall(WS, 'test', '0001')
    expect(meta).toMatchObject({ tool: 'quiet', because: 'no change since 09-26' })
  })

  it('refuses a missing reason, and a parameter it does not take', async () => {
    const { quiet } = tools()
    expect(await quiet({})).toMatch(/^error: because is required/)
    expect(await quiet({ because: 'x', out: 'data/q.txt' })).toMatch(/unexpected parameter "out"/)
  })
})

describe('quiet when a person wrote in the turn', () => {
  const PUSH = { name: 'forge', event: 'push', delivery: 'd-1' }

  const scripted = (steps, inputs) => ({
    use: () => ({
      answer: async (input) => {
        inputs.push(input)
        return steps[inputs.length - 1]()
      }
    })
  })

  const quietCall = { status: 'tool_use', toolCalls: [{ id: 'q', name: 'quiet', arguments: { because: 'push to main, nothing actionable' } }] }
  const toolResults = (input) => input.filter(m => m.role === 'tool').map(textOf)

  const turn = (steps, inputs) => runSpore({
    workspace: WS,
    identity: 'You are a spore under test.',
    modelId: 'fake/model',
    limits: { rounds: { soft: 10, hard: 12 } },
    mo: scripted(steps, inputs),
    state: hostState(WS)
  })

  it('names the message in the refusal', async () => {
    const { quiet } = tools({ unanswered: () => ({ text: 'scanning finished ?' }) })
    expect(await quiet({ because: 'nothing to do' })).toMatch(/someone wrote to you in this turn \("scanning finished \?"\)/)
  })

  it('ends a turn only webhooks spoke in', async () => {
    enqueue(WS, '', { hook: PUSH, attach: [{ name: 'payload.json', mime: 'application/json', data: Buffer.from('{}') }] })
    const result = await turn([() => quietCall], [])
    expect(result).toMatchObject({ stopReason: 'quiet', output: null })
  })

  it('is refused when a person wrote alongside a webhook, and the turn answers instead', async () => {
    enqueue(WS, 'scanning finished ?')
    enqueue(WS, '', { hook: PUSH, attach: [{ name: 'payload.json', mime: 'application/json', data: Buffer.from('{}') }] })
    const inputs = []
    const result = await turn([() => quietCall, () => ({ status: 'completed', output: 'not yet — page 430 of 445' })], inputs)
    expect(toolResults(inputs[1]).join('\n')).toMatch(/someone wrote to you in this turn \("scanning finished \?"\)/)
    expect(result).toMatchObject({ stopReason: 'answer', output: 'not yet — page 430 of 445' })
  })

  it('is refused when a person writes while a webhook turn is running', async () => {
    enqueue(WS, '', { hook: PUSH, attach: [{ name: 'payload.json', mime: 'application/json', data: Buffer.from('{}') }] })
    const inputs = []
    const result = await turn([
      () => {
        enqueue(WS, 'scanning finished ?')
        return { status: 'tool_use', toolCalls: [{ id: 'r', name: 'read', arguments: { path: 'data/absent.txt' } }] }
      },
      () => quietCall,
      () => ({ status: 'completed', output: 'not yet' })
    ], inputs)
    expect(toolResults(inputs[2]).join('\n')).toMatch(/someone wrote to you in this turn/)
    expect(result).toMatchObject({ stopReason: 'answer', output: 'not yet' })
  })
})

describe('a turn that ends quiet', () => {
  const quietly = (because) => ({
    use: () => ({
      answer: async () => ({ status: 'tool_use', toolCalls: [{ id: 'q1', name: 'quiet', arguments: { because } }] })
    })
  })

  const run = (because = 'nothing changed') => runSpore({
    prompt: 'check the queue',
    workspace: WS,
    identity: 'You are a spore under test.',
    modelId: 'fake/model',
    limits: { rounds: { soft: 10, hard: 12 } },
    mo: quietly(because),
    state: hostState(WS)
  })

  it('has no output and says why in its record', async () => {
    const result = await run()
    expect(result).toMatchObject({ stopReason: 'quiet', output: null, because: 'nothing changed' })
    expect(readPending(WS)).toMatchObject({ stopReason: 'quiet', concluded: true, because: 'nothing changed', output: null })
  })

  it('ends quiet on a reason that begins "error:", which is what the model wrote and not a refusal', async () => {
    const result = await run('error: none of the feeds changed since yesterday')
    expect(result).toMatchObject({ stopReason: 'quiet', output: null, because: 'error: none of the feeds changed since yesterday' })
  })

  it('tells a watcher it ended quiet without handing it the reason as an answer', async () => {
    await run()
    const [complete] = readEvents(WS, { event: 'complete' })
    expect(complete).toMatchObject({ stopReason: 'quiet', output: null, because: 'nothing changed', terminal: true })
  })
})
