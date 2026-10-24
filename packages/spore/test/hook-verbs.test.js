import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { listHooks, showHook } from '../src/library/hooks.js'
import { appendTurn, enqueue, holdDelivery } from '../src/core/spore-dir.js'
import { outsideRoot } from './fixtures/outside-ws.js'

const DEFINITION = '---\nname: t\nmodel: anthropic/claude-haiku-4-5\ntools: [read]\nrounds: [2, 3]\ncost: [0.1, 0.2]\nwall: [1m, 2m]\n---\n\nyou are a test.\n'
const ENV = { HOOK_TOKEN: 't' }

let root
let home
let configFile

const spore = (name) => {
  const ws = join(home, name)
  mkdirSync(ws, { recursive: true })
  writeFileSync(join(ws, 'spore.cmk'), DEFINITION)
  return ws
}
const hooks = (described) => writeFileSync(join(root, 'hooks.json'), JSON.stringify(described))
const delivered = (ws, hook, delivery, event = 'push') => enqueue(ws, '', { attach: [{ name: 'headers.json', mime: 'application/json', data: Buffer.from('{}') }], hook: { name: hook, event, delivery } }).inbox

beforeEach(() => {
  root = outsideRoot('spore-hooks')
  home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  configFile = join(root, 'config.json')
  writeFileSync(configFile, JSON.stringify({ home }))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('spore hook ls', () => {
  it('lists each hook with its spores, what it said to each this week, and a spore that does not exist', () => {
    const main = spore('main')
    hooks({
      gh: { spore: ['main', 'ghost'], verify: { preset: 'github', secret: '${HOOK_TOKEN}' } }, // eslint-disable-line no-template-curly-in-string
      ops: { spore: 'main', verify: { token: '${HOOK_TOKEN}' }, accept: { header: 'x-kind', values: ['alert'] } } // eslint-disable-line no-template-curly-in-string
    })
    delivered(main, 'gh', 'd-1')
    delivered(main, 'gh', 'd-2')
    const { hooks: listed } = listHooks({ configFile, env: ENV })
    expect(listed.map(hook => hook.name)).toEqual(['gh', 'ops'])
    const [gh, ops] = listed
    expect(gh).toMatchObject({ path: '/hook/gh', verify: { method: 'hmac', header: 'x-hub-signature-256' }, accept: null })
    expect(gh.spores[0]).toMatchObject({ name: 'main', ws: main, count: 2, held: [], router: null, triage: null })
    expect(gh.spores[0].deliveries.map(d => d.delivery)).toEqual(['d-2'])
    expect(gh.spores[1]).toEqual({ name: 'ghost', ws: null })
    expect(ops).toMatchObject({ verify: { method: 'path', header: null }, accept: { header: 'x-kind', values: ['alert'], payload: false } })
    expect(ops.spores[0]).toMatchObject({ count: 0, last: null })
  })

  it('refuses when a hook wants a secret that is not set, as the service would', () => {
    spore('main')
    hooks({ gh: { spore: 'main', verify: { token: '${HOOK_TOKEN}' } } }) // eslint-disable-line no-template-curly-in-string
    expect(() => listHooks({ configFile, env: {} })).toThrow(/wants \$HOOK_TOKEN, which is not set/)
  })
})

describe('spore hook show', () => {
  it('gives the last deliveries newest first, each with the turn that read it, and those still held', () => {
    const main = spore('main')
    hooks({ gh: { spore: 'main', verify: { token: '${HOOK_TOKEN}' }, maxWait: '30m' } }) // eslint-disable-line no-template-curly-in-string
    delivered(main, 'gh', 'd-1')
    appendTurn(main, { startedAt: new Date().toISOString(), stopReason: 'answer', concluded: true, inboxTo: 1 })
    delivered(main, 'gh', 'd-2')
    delivered(main, 'other', 'x-1')
    const now = Date.now()
    holdDelivery(main, '', {
      attach: [{ name: 'headers.json', mime: 'application/json', data: Buffer.from('{}') }],
      hook: { name: 'gh', event: 'push', delivery: 'd-3' },
      releaseAt: new Date(now + 60_000).toISOString(),
      deadline: new Date(now + 1_800_000).toISOString()
    })

    const shown = showHook('gh', { configFile, env: ENV })
    expect(shown.maxWait).toBe(1_800_000)
    const [one] = shown.spores
    expect(one.deliveries).toEqual([
      expect.objectContaining({ delivery: 'd-2', event: 'push', consumed: false, turnNo: null }),
      expect.objectContaining({ delivery: 'd-1', consumed: true, turnNo: 1, stopReason: 'answer' })
    ])
    expect(one.held).toEqual([expect.objectContaining({ deadline: new Date(now + 1_800_000).toISOString() })])
  })

  it('refuses a hook hooks.json does not name, saying which it does', () => {
    spore('main')
    hooks({ gh: { spore: 'main', verify: { token: '${HOOK_TOKEN}' } } }) // eslint-disable-line no-template-curly-in-string
    expect(() => showHook('nope', { configFile, env: ENV })).toThrow(expect.objectContaining({ type: 'WEBHOOK_UNKNOWN', detail: expect.stringMatching(/names gh$/) }))
  })
})
