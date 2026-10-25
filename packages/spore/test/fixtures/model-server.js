/**
 * A tree's model socket, served from a script instead of from the runner and a provider, for a
 * test that stands where a runner would: one starting `spore-spawn` or `fanout.js` as an agent
 * does, or calling the model client. A turn a test starts goes through `startGate` instead.
 *
 * It speaks what the runner speaks — mohdel's call protocol (`POST /v1/call`, NDJSON events
 * ending in `done` or `error`, answered to its end and counted whether or not anyone is still
 * reading, as the root's own when marked so; `POST /v1/embed`, one JSON result),
 * `POST /spore/info` and `GET /spore/spend` — and answers each call from `mo.use(model).answer(prompt, { tools,
 * realtimeHandler })`, the shape `scriptedMo` gives, and each embedding from
 * `mo.use(model).embed(input, { inputType })`.
 */

import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { CALLER_HEADER, KEY_HEADER, ROOT_CALLER } from '../../src/infra/socket-request.js'
import { MODEL_KEY_FILE } from '../../src/core/spore-dir.js'
import { CONFIG_FILE } from '../../src/library/config.js'
import { brokerSocketPath } from '../../src/infra/broker-socket.js'

/** The key a runner leaves in the workspace for its cells, for a test standing where the runner would. */
export function suppliedKey (ws) {
  const key = randomBytes(32).toString('hex')
  mkdirSync(ws, { recursive: true })
  writeFileSync(resolve(ws, MODEL_KEY_FILE), key)
  return key
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null))
  req.on('error', reject)
})

export function createModelServer ({ mo, socketPath, limit, key }) {
  // `children` as the old broker named it: everything the socket has served.
  const ledger = { children: 0, rounds: 0, own: 0, ownRounds: 0 }
  const envelopes = []

  const answer = async (req, res) => {
    if (limit !== undefined && ledger.children >= limit) {
      json(res, 402, { message: 'budget exhausted', type: 'BUDGET_EXHAUSTED', detail: `spent $${ledger.children.toFixed(4)} of $${limit}`, severity: 'error', retryable: false })
      return
    }
    const envelope = await readBody(req)
    envelopes.push({ envelope, headers: req.headers })
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    const send = (event) => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(event) + '\n') }
    const own = req.headers[CALLER_HEADER] === ROOT_CALLER
    try {
      const result = await mo.use(envelope.model).answer(envelope.prompt, {
        tools: envelope.tools,
        realtimeHandler: (chunk) => send({ type: 'delta', delta: chunk })
      })
      ledger.children += result?.cost || 0
      ledger.rounds += 1
      if (own) {
        ledger.own += result?.cost || 0
        ledger.ownRounds += 1
      }
      send({ type: 'done', result })
    } catch (err) {
      send({ type: 'error', error: { message: err.message, type: err.type, detail: err.detail, retryable: Boolean(err.retryable), severity: 'error' } })
    }
    if (!res.destroyed) res.end()
  }

  const embed = async (req, res) => {
    if (limit !== undefined && ledger.children >= limit) {
      json(res, 402, { message: 'budget exhausted', type: 'BUDGET_EXHAUSTED', severity: 'error', retryable: false })
      return
    }
    const envelope = await readBody(req)
    envelopes.push({ envelope, headers: req.headers })
    try {
      const result = await mo.use(envelope.model).embed(envelope.input, { inputType: envelope.inputType })
      ledger.children += result.cost || 0
      json(res, 200, result)
    } catch (err) {
      json(res, 400, { message: err.message, type: err.type, detail: err.detail, retryable: Boolean(err.retryable), severity: 'error' })
    }
  }

  const server = http.createServer(async (req, res) => {
    if (key && req.headers[KEY_HEADER] !== key) {
      json(res, 401, { message: 'not this tree', type: 'BROKER_UNAUTHORIZED', severity: 'error', retryable: false })
      return
    }
    if (req.method === 'POST' && req.url === '/v1/call') return answer(req, res)
    if (req.method === 'POST' && req.url === '/v1/embed') return embed(req, res)
    if (req.method === 'POST' && req.url === '/spore/info') {
      const { model } = await readBody(req)
      return json(res, 200, mo.use(model).info?.() ?? null)
    }
    if (req.method === 'GET' && req.url === '/spore/spend') return json(res, 200, { spend: ledger.children, rounds: ledger.rounds, own: ledger.own, ownRounds: ledger.ownRounds })
    json(res, 404, { message: 'unknown route', type: 'PROTOCOL_NOT_FOUND', severity: 'error', retryable: false })
  })

  return {
    socketPath,
    ledger,
    envelopes,
    listen: () => new Promise(resolve => server.listen(socketPath, resolve)),
    close: () => new Promise(resolve => {
      server.closeAllConnections()
      server.close(() => {
        try { unlinkSync(socketPath) } catch {}
        resolve()
      })
    })
  }
}

/**
 * A host's mohdel gate, answering from a script: what a runner, and a cell outside any turn,
 * calls through when `config.json` names a `gate` (mohdel's PROTOCOL.md §10), so the runner holds
 * every bound it holds for a real host. `POST /v1/info` answers `mo.use(model).info()`;
 * `POST /v1/call` streams `mo.use(model).answer(prompt, { tools, realtimeHandler })` — each delta,
 * then the result completed to what a gate sends, or its error; `POST /v1/abort` ends a call still
 * streaming on an aborted `done`, as a gate does; `POST /v1/embed` answers
 * `mo.use(model).embed(input, { inputType })` the same way. Every envelope is kept, `authId` and
 * all, every abort taken, and `spent` is the cost of every result it sent.
 */
export function createGate ({ mo, socketPath }) {
  const envelopes = []
  const aborts = []
  const streaming = new Map()
  const ledger = { spent: 0, calls: 0 }
  const now = () => String(process.hrtime.bigint())
  const typed = (err) => ({
    message: err.message,
    type: err.type ?? 'PROVIDER_ERROR',
    ...(err.detail === undefined ? {} : { detail: err.detail }),
    retryable: Boolean(err.retryable),
    ...(err.retryAfterMs === undefined ? {} : { retryAfterMs: err.retryAfterMs }),
    severity: 'error'
  })

  const call = async (req, res) => {
    const envelope = await readBody(req)
    envelopes.push(envelope)
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'mohdel-gate': 'scripted' })
    res.flushHeaders()
    const send = (event) => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(event) + '\n') }
    const start = now()
    const key = `${envelope.authId}/${envelope.callId}`
    streaming.set(key, () => {
      send({ type: 'done', result: { status: 'incomplete', warning: 'aborted', inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cost: 0, timestamps: { start, first: start, end: now() } } })
      res.end()
    })
    try {
      const result = await mo.use(envelope.model).answer(envelope.prompt, {
        tools: envelope.tools,
        realtimeHandler: (delta) => send({ type: 'delta', delta })
      })
      const done = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cost: 0, timestamps: { start, first: start, end: now() }, ...result }
      ledger.spent += done.cost
      ledger.calls += 1
      send({ type: 'done', result: done })
    } catch (err) {
      send({ type: 'error', error: typed(err) })
    }
    streaming.delete(key)
    if (!res.destroyed) res.end()
  }

  const abort = async (req, res) => {
    const request = await readBody(req)
    if (request.gate !== 'scripted') return json(res, 421, { message: 'abort sent to a gate that did not stream the call', type: 'CALL_MISDIRECTED', severity: 'error', retryable: false })
    const ending = streaming.get(`${request.authId}/${request.callId}`)
    if (!ending) return json(res, 404, { message: 'no such call in flight', type: 'CALL_NOT_FOUND', severity: 'warn', retryable: false })
    streaming.delete(`${request.authId}/${request.callId}`)
    aborts.push(request)
    ending()
    res.writeHead(202).end()
  }

  const embed = async (req, res) => {
    const envelope = await readBody(req)
    envelopes.push(envelope)
    try {
      const result = await mo.use(envelope.model).embed(envelope.input, { inputType: envelope.inputType })
      const at = now()
      const done = { status: 'completed', dimensions: result.vectors[0].length, inputType: envelope.inputType ?? null, inputTokens: 0, cost: 0, timestamps: { start: at, first: at, end: at }, ...result }
      ledger.spent += done.cost
      json(res, 200, done)
    } catch (err) {
      json(res, 400, typed(err))
    }
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/call') return call(req, res)
    if (req.method === 'POST' && req.url === '/v1/embed') return embed(req, res)
    if (req.method === 'POST' && req.url === '/v1/abort') return abort(req, res)
    if (req.method === 'POST' && req.url === '/v1/info') return json(res, 200, mo.use((await readBody(req)).model).info())
    json(res, 404, { message: 'unknown route', type: 'PROTOCOL_NOT_FOUND', severity: 'error', retryable: false })
  })

  return {
    socketPath,
    envelopes,
    aborts,
    ledger,
    listen: () => new Promise(resolve => server.listen(socketPath, resolve)),
    close: () => new Promise(resolve => {
      server.closeAllConnections()
      server.close(() => {
        try { unlinkSync(socketPath) } catch {}
        resolve()
      })
    })
  }
}

/**
 * A scripted gate, listening, and named as the host's in this test file's `config.json` — what
 * every turn a test starts through `send` then calls through. `configure(fields, file)` writes a
 * config holding `fields` and the gate.
 */
export async function startGate ({ mo, name }) {
  const gate = createGate({ mo, socketPath: brokerSocketPath(name) })
  await gate.listen()
  gate.configure = (fields = {}, file = CONFIG_FILE) => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ ...fields, gate: gate.socketPath }))
  }
  gate.configure()
  return gate
}
