import { timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { MAX_EVIDENCE, openChecked } from './checked.js'
import { CairnError } from './errors.js'
import { readInstance } from './instance.js'

const STATUS = {
  unauthenticated: 401,
  'not-a-member': 403,
  'stale-head': 409,
  'too-large': 413,
  'unknown-kind': 422,
  'shape-mismatch': 422,
  'bad-ref': 422,
  'bad-time': 422
}

const APPEND_BODY = 64 * 1024
const EVIDENCE_BODY = Math.ceil(MAX_EVIDENCE / 3) * 4 + 1024
export const MAX_SOCKET_PATH = 107
export const CAIRN_NAME = /^[a-z0-9][a-z0-9-]*$/
const BODY_KEYS = new Set(['kind', 'at', 'refs', 'data', 'expectedHead'])

export const tokenVariable = (name) => `CAIRN_${name.toUpperCase().replaceAll('-', '_')}_TOKEN`

const refuse = (type, message, detail) => new CairnError(message, { type, detail })
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function sameToken (header, token) {
  const given = Buffer.from(header ?? '', 'utf8')
  const expected = Buffer.from(`Bearer ${token}`, 'utf8')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

async function bodyOf (req, limit) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size <= limit) chunks.push(chunk)
  }
  if (size > limit) throw refuse('too-large', `the request is ${size} bytes, past ${limit}`, String(size))
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw refuse('shape-mismatch', 'the request body is not JSON', '$')
  }
}

async function claimSocket (socket) {
  const bytes = Buffer.byteLength(socket, 'utf8')
  if (bytes > MAX_SOCKET_PATH) throw new Error(`${socket} is ${bytes} bytes, and a unix socket path is at most ${MAX_SOCKET_PATH}`)
  if (!existsSync(socket)) return
  const live = await new Promise((resolve, reject) => {
    const probe = connect(socket)
    probe.once('connect', () => { probe.destroy(); resolve(true) })
    probe.once('error', (err) => err.code === 'ECONNREFUSED' ? resolve(false) : reject(err))
  })
  if (live) throw new Error(`${socket} is served by another daemon`)
  unlinkSync(socket)
}

/**
 * One cairn's daemon: HTTP on a unix socket, `POST /append` and `POST /evidence`, over
 * `openChecked`, which holds the rules. Who writes comes from the `X-Cairn-*` headers and the
 * instance file, never from the body, and every request carries the cairn's token. A member asks
 * to be woken by kinds others write with `cairn.subscribe`, and stops with `cairn.unsubscribe`,
 * `{ kinds: [...] }` either, written as any entry; subscribing needs the instance file's `notify`.
 * `appended` is called after each entry a request writes, for whoever wakes the members.
 */
export async function serve ({ name, instanceFile, file, socket, token, appended = () => {} }) {
  const instance = readInstance(instanceFile)
  await claimSocket(socket)
  const cairn = openChecked(file, { name, instance })

  async function store (req) {
    const body = await bodyOf(req, EVIDENCE_BODY)
    if (!isObject(body)) throw refuse('shape-mismatch', 'the request body is an object', '$')
    for (const key of Object.keys(body)) {
      if (key !== 'base64') throw refuse('shape-mismatch', `${key} is not part of evidence`, `$.${key}`)
    }
    const bytes = typeof body.base64 === 'string' ? Buffer.from(body.base64, 'base64') : null
    if (!bytes || bytes.toString('base64') !== body.base64) throw refuse('shape-mismatch', 'base64 is the evidence in standard, padded base64', '$.base64')
    return cairn.store(req.headers['x-cairn-actor'], bytes)
  }

  async function append (req) {
    const hop = req.headers['x-cairn-hop']
    if (!/^\d+$/.test(hop ?? '')) throw refuse('shape-mismatch', 'X-Cairn-Hop is a count', '$.hop')
    const body = await bodyOf(req, APPEND_BODY)
    if (!isObject(body)) throw refuse('shape-mismatch', 'the request body is an object', '$')
    for (const key of Object.keys(body)) {
      if (!BODY_KEYS.has(key)) throw refuse('shape-mismatch', `${key} is not the writer's to send`, `$.${key}`)
    }
    const { expectedHead, ...said } = body
    const written = cairn.append({
      ...said,
      actor: req.headers['x-cairn-actor'],
      via: req.headers['x-cairn-via'],
      id: req.headers['x-cairn-id'] ?? null,
      hop: Number(hop)
    }, { expectedHead })
    setImmediate(appended, written)
    return written
  }

  async function handle (req) {
    if (!sameToken(req.headers.authorization, token)) throw refuse('unauthenticated', `a request to ${name} carries its token`, '')
    if (req.method === 'POST' && req.url === '/append') return [200, await append(req)]
    if (req.method === 'POST' && req.url === '/evidence') return [200, await store(req)]
    return [404, { error: { type: 'not-found', message: `${req.method} ${req.url} is not a verb of cairn`, detail: req.url } }]
  }

  const server = createServer((req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    handle(req).then(([status, body]) => reply(status, body), (err) => {
      if (err instanceof CairnError && STATUS[err.type]) {
        reply(STATUS[err.type], { error: { type: err.type, message: err.message, detail: err.detail } })
        return
      }
      console.error(err)
      reply(500, { error: { type: 'internal', message: err.message } })
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, resolve)
  })
  chmodSync(socket, 0o600)

  return {
    close: () => new Promise((resolve, reject) => {
      server.close(() => {
        try {
          cairn.close()
          resolve()
        } catch (err) {
          reject(err)
        }
      })
      server.closeAllConnections()
    })
  }
}
