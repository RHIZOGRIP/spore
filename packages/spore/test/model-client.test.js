import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createModelClient, IDLE_HEARTBEAT_MS } from '../src/infra/model-client.js'
import { CALLER_HEADER, MODEL_CALL_HEADER, KEY_HEADER, PRECURSOR_CALLER, ROOT_CALLER } from '../src/infra/socket-request.js'
import { createModelServer, testSocket } from './fixtures/model-server.js'
import { answers, calls, scriptedMo } from './fixtures/scripted-model.js'

const MODEL = 'anthropic/claude-haiku-4-5'
const KEY = 'k'.repeat(64)
const WS = '/home/someone/.spore/main'
const PROMPT = [{ role: 'system', content: [{ type: 'text', text: 'sys' }] }, { role: 'user', content: 'hi' }]

const until = async (done, limitMs = 5000) => {
  const deadline = Date.now() + limitMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error('waited too long')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

let server
afterEach(async () => {
  await server?.close()
  server = null
})

const serve = async (reply, opts = {}) => {
  server = createModelServer({ mo: scriptedMo(reply), socketPath: testSocket('model-client'), key: KEY, ...opts })
  await server.listen()
  return server
}

describe('the model client', () => {
  it('sends a wire envelope with the tree key beside it and no provider key', async () => {
    await serve(async () => calls('read', { path: 'data/a.md' }))
    const mo = await createModelClient({ socketPath: server.socketPath, modelIds: [MODEL], key: KEY, workspace: WS })
    const tools = [{ name: 'read', description: 'read', parameters: { type: 'object', properties: {} } }]

    const result = await mo.use(MODEL).answer(PROMPT, { tools })

    expect(result.status).toBe('tool_use')
    const [{ envelope, headers }] = server.envelopes
    expect(headers[KEY_HEADER]).toBe(KEY)
    expect(envelope).toMatchObject({ authId: 'spore', model: MODEL, prompt: PROMPT, tools })
    expect(envelope.auth).toBeUndefined()
    expect(envelope.callId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('asks for reasoning summaries and raw reasoning only when the call does', async () => {
    await serve(async () => answers('x'))
    const mo = await createModelClient({ socketPath: server.socketPath, modelIds: [MODEL], key: KEY, workspace: WS })
    await mo.use(MODEL).answer(PROMPT, { reasoningSummaries: true, rawReasoning: true })
    await mo.use(MODEL).answer(PROMPT)
    const [asked, plain] = server.envelopes.map(({ envelope }) => envelope)
    expect(asked).toMatchObject({ reasoningSummaries: true, rawReasoning: true })
    expect(plain).not.toHaveProperty('reasoningSummaries')
    expect(plain).not.toHaveProperty('rawReasoning')
  })

  it('names its workspace to the provider by a hash, the same on every call and another for another workspace', async () => {
    await serve(async () => answers('x'))
    const mo = await createModelClient({ socketPath: server.socketPath, modelIds: [MODEL], key: KEY, workspace: WS })
    await mo.use(MODEL).answer(PROMPT)
    await mo.use(MODEL).answer(PROMPT)
    const other = await createModelClient({ socketPath: server.socketPath, modelIds: [MODEL], key: KEY, workspace: `${WS}-2` })
    await other.use(MODEL).answer(PROMPT)

    const [first, second, third] = server.envelopes.map(({ envelope }) => envelope.identifier)
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(second).toBe(first)
    expect(third).not.toBe(first)
    expect(first).not.toContain('someone')
  })

  it('reads each model\'s entry once, when it is built', async () => {
    await serve(async () => answers('x'))
    const mo = await createModelClient({ socketPath: server.socketPath, modelIds: [MODEL], key: KEY, workspace: WS })
    expect(mo.use(MODEL).info()).toMatchObject({ contextTokenLimit: 200000 })
  })

  it('is refused by a socket of another tree', async () => {
    await serve(async () => answers('x'))
    await expect(createModelClient({ socketPath: server.socketPath, modelIds: [MODEL], key: 'j'.repeat(64), workspace: WS }))
      .rejects.toMatchObject({ type: 'BROKER_UNAUTHORIZED' })
  })

  it('hands streamed chunks to the handler, merged as mohdel merges them', async () => {
    await serve(async (input, round, options) => {
      for (const delta of ['hel', 'lo']) options.realtimeHandler({ type: 'message', delta })
      return answers('hello')
    })
    const mo = await createModelClient({ socketPath: server.socketPath, modelIds: [MODEL], key: KEY, workspace: WS })
    const chunks = []
    await mo.use(MODEL).answer(PROMPT, { realtimeHandler: (chunk) => chunks.push(chunk), bufferOpts: { maxChars: 50, maxMs: 500 } })
    expect(chunks).toEqual([{ type: 'message', delta: 'hello' }])
  })

  it('asks mohdel to report a silent provider, and counts each report on the result', async () => {
    await serve(async (input, round, options) => {
      options.idle(30_000)
      options.idle(60_000)
      return answers('late')
    })
    const mo = await createModelClient({ socketPath: server.socketPath, modelIds: [MODEL], key: KEY, workspace: WS })
    const reported = []
    const result = await mo.use(MODEL).answer(PROMPT, { idleHandler: (sinceMs) => reported.push(sinceMs) })
    expect(server.envelopes[0].envelope.idleHeartbeatMs).toBe(IDLE_HEARTBEAT_MS)
    expect(reported).toEqual([30_000, 60_000])
    expect(result).toMatchObject({ output: 'late', idleEventCount: 2, idleMaxMs: 60_000 })
  })

  it('throws an error event as a typed error, so recovery can classify it', async () => {
    await serve(async () => { throw Object.assign(new Error('context length exceeded'), { type: 'CONTEXT_OVERFLOW' }) })
    const mo = await createModelClient({ socketPath: server.socketPath, modelIds: [MODEL], key: KEY, workspace: WS })
    await expect(mo.use(MODEL).answer(PROMPT)).rejects.toMatchObject({ type: 'CONTEXT_OVERFLOW' })
  })

  it('is refused once the tree has reached its hard limit', async () => {
    await serve(async () => answers('x', 0.2), { limit: 0.2 })
    const mo = await createModelClient({ socketPath: server.socketPath, modelIds: [MODEL], key: KEY, workspace: WS })
    await mo.use(MODEL).answer(PROMPT)
    await expect(mo.use(MODEL).answer(PROMPT)).rejects.toMatchObject({ type: 'BUDGET_EXHAUSTED' })
  })

  it('learns what its cells spent from what the tree spent', async () => {
    await serve(async () => answers('x', 0.01))
    const root = await createModelClient({ socketPath: server.socketPath, modelIds: [MODEL], key: KEY, workspace: WS, tracksTree: true })
    const cell = await createModelClient({ socketPath: server.socketPath, modelIds: [MODEL], key: KEY, workspace: WS })
    await root.use(MODEL).answer(PROMPT)
    await cell.use(MODEL).answer(PROMPT)
    await cell.use(MODEL).answer(PROMPT)
    const ledger = await root.spend()
    expect(ledger.children).toBeCloseTo(0.02)
    expect(ledger.ownRounds).toBe(1)
    expect(ledger.childRounds).toBe(2)
  })

  it('rejects a call that was aborted, which is how the loop records a cancelled turn', async () => {
    await serve(async () => new Promise(() => {}))
    const mo = await createModelClient({ socketPath: server.socketPath, modelIds: [MODEL], key: KEY, workspace: WS })
    const stop = new AbortController()
    const asked = mo.use(MODEL).answer(PROMPT, { signal: stop.signal })
    setTimeout(() => stop.abort(), 50)
    await expect(asked).rejects.toMatchObject({ type: 'OPERATION_CANCELLED' })
  })

  it('stops waiting on an abort and leaves the call to finish, counted as its own', async () => {
    let finish = null
    await serve(async (input, round) => {
      if (round === 0) return answers('x', 0.01)
      await new Promise(resolve => { finish = resolve })
      return answers('late', 0.03)
    })
    const root = await createModelClient({ socketPath: server.socketPath, modelIds: [MODEL], key: KEY, workspace: WS, tracksTree: true })
    await root.use(MODEL).answer(PROMPT)
    const stop = new AbortController()
    const asked = root.use(MODEL).answer(PROMPT, { signal: stop.signal })
    await until(() => finish)
    stop.abort()
    await expect(asked).rejects.toMatchObject({ type: 'OPERATION_CANCELLED' })
    finish()
    await until(() => server.ledger.rounds === 2)
    const ledger = await root.spend()
    expect(ledger.children).toBeCloseTo(0)
    expect(ledger.ownRounds).toBe(2)
    expect(ledger.childRounds).toBe(0)
  })

  it('names each call by its id, and by who made it: the root agent, a precursor\'s cell, or nobody', async () => {
    await serve(async () => answers('x'))
    const root = await createModelClient({ socketPath: server.socketPath, modelIds: [MODEL, 'openai/text-embedding-3-small'], key: KEY, workspace: WS, tracksTree: true })
    const cell = await createModelClient({ socketPath: server.socketPath, modelIds: [MODEL], key: KEY, workspace: WS, precursor: 'summarize' })
    const unnamed = await createModelClient({ socketPath: server.socketPath, modelIds: [MODEL], key: KEY, workspace: WS })
    await root.use(MODEL).answer(PROMPT)
    await cell.use(MODEL).answer(PROMPT)
    await unnamed.use(MODEL).answer(PROMPT)
    await root.use('openai/text-embedding-3-small').embed(['a']).catch(() => {})
    const [fromRoot, fromCell, fromNobody, embedded] = server.envelopes
    expect(fromRoot.headers[MODEL_CALL_HEADER]).toBe(fromRoot.envelope.callId)
    expect(fromRoot.headers[CALLER_HEADER]).toBe(ROOT_CALLER)
    expect(fromCell.headers[MODEL_CALL_HEADER]).toBe(fromCell.envelope.callId)
    expect(fromCell.headers[CALLER_HEADER]).toBe(`${PRECURSOR_CALLER}summarize`)
    expect(fromNobody.headers[CALLER_HEADER]).toBeUndefined()
    expect(embedded.headers[CALLER_HEADER]).toBe(ROOT_CALLER)
  })

  it('embeds through the socket with the tree key, and the tree counts it as spend but not a round', async () => {
    const embedding = 'openai/text-embedding-3-small'
    const mo = { use: () => ({ embed: async (input) => ({ status: 'completed', vectors: input.map(() => [1, 0]), dimensions: 2, inputType: null, inputTokens: 3, cost: 0.002 }) }) }
    server = createModelServer({ mo, socketPath: testSocket('model-client'), key: KEY })
    await server.listen()
    const root = await createModelClient({ socketPath: server.socketPath, modelIds: [embedding], key: KEY, workspace: WS, tracksTree: true })

    const result = await root.use(embedding).embed(['a', 'b'], { inputType: 'document' })

    expect(result.vectors).toHaveLength(2)
    const [{ envelope, headers }] = server.envelopes
    expect(headers[KEY_HEADER]).toBe(KEY)
    expect(envelope).toMatchObject({ authId: 'spore', model: embedding, input: ['a', 'b'], inputType: 'document' })
    expect(envelope.auth).toBeUndefined()
    const ledger = await root.spend()
    expect(ledger.children).toBeCloseTo(0.002)
    expect(ledger.childRounds).toBe(0)
  })

  it('throws a refused embedding as a typed error', async () => {
    await serve(async () => answers('x'), { limit: 0 })
    const mo = await createModelClient({ socketPath: server.socketPath, modelIds: ['openai/text-embedding-3-small'], key: KEY, workspace: WS })
    await expect(mo.use('openai/text-embedding-3-small').embed(['a'])).rejects.toMatchObject({ type: 'BUDGET_EXHAUSTED' })
  })

  it('refuses an option it would not carry', async () => {
    await serve(async () => answers('x'))
    const mo = await createModelClient({ socketPath: server.socketPath, modelIds: [MODEL], key: KEY, workspace: WS })
    await expect(mo.use(MODEL).answer(PROMPT, { idleHeartbeatMs: 1000 })).rejects.toMatchObject({ type: 'BROKER_BAD_OPTION' })
  })
})

// The Rust crates and the session JS talk a private protocol, so they are one release.
describe('the mohdel release', () => {
  it('is the same in npm and in Cargo', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const npm = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).dependencies.mohdel
    const cargo = readFileSync(resolve(root, '../../rust/runner/Cargo.toml'), 'utf8')
    expect(npm).toMatch(/^\d+\.\d+\.\d+$/)
    for (const crate of ['mohdel-thin-gate', 'mohdel-client']) {
      expect(cargo.match(new RegExp(`${crate} = \\{[^}]*tag = "v([^"]+)"`))?.[1], crate).toBe(npm)
    }
  })
})
