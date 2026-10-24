/**
 * A tree's model socket, served from a script instead of from the runner and a provider.
 *
 * It speaks what the runner speaks — mohdel's call protocol (`POST /v1/call`, NDJSON events
 * ending in `done` or `error`, answered to its end and counted whether or not anyone is still
 * reading, as the root's own when marked so; `POST /v1/embed`, one JSON result),
 * `POST /spore/info` and `GET /spore/spend` — and answers each call from `mo.use(model).answer(prompt, { tools,
 * realtimeHandler })`, the shape `scriptedMo` gives, and each embedding from
 * `mo.use(model).embed(input, { inputType })`. A test hands its socket to `spore` as
 * SPORE_MODEL_SOCKET.
 */

import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { CALLER_HEADER, KEY_HEADER, ROOT_CALLER } from '../../src/infra/socket-request.js'
import { MODEL_KEY_FILE } from '../../src/core/spore-dir.js'

/** The key a supplier of the model socket leaves in the workspace, which the runner keeps as found. */
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
