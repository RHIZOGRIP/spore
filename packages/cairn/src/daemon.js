import { timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { openCairn } from './cairn.js'
import { canonical } from './canonical.js'
import { CairnError } from './errors.js'
import { readInstance } from './instance.js'
import { checkShape } from './shape.js'

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

const MAX_LINE = 4096
const MAX_BODY = 64 * 1024
const MAX_SOCKET_PATH = 107
const VIA = new Set(['agent', 'program', 'cli'])
const BODY_KEYS = new Set(['kind', 'at', 'refs', 'data', 'expectedHead'])
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const SHA256 = /^[0-9a-f]{64}$/

const refuse = (type, message, detail) => new CairnError(message, { type, detail })
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function checkAt (at, now) {
  const when = typeof at === 'string' && UTC.test(at) ? new Date(at) : null
  if (!when || Number.isNaN(when.getTime()) || when.toISOString().slice(0, 19) !== at.slice(0, 19)) {
    throw refuse('bad-time', '$.at is a UTC time, YYYY-MM-DDTHH:MM:SS[.fff]Z', '$.at')
  }
  if (when.getTime() > now) throw refuse('bad-time', `$.at is ${at}, which is in the future`, '$.at')
}

function checkRefs (refs, subjects, headSeq) {
  if (!isObject(refs)) throw refuse('shape-mismatch', 'refs is a map of subject keys to ids', '$.refs')
  for (const [key, value] of Object.entries(refs)) {
    const at = `$.refs.${key}`
    const subject = subjects.get(key)
    if (subject === undefined) throw refuse('bad-ref', `${key} is not a subject of this cairn`, at)
    if (subject === 'seq') {
      if (!Number.isSafeInteger(value) || value < 1 || value > headSeq) throw refuse('bad-ref', `${at} is the seq of an entry in this cairn`, at)
    } else if (subject === 'sha256') {
      if (typeof value !== 'string' || !SHA256.test(value)) throw refuse('bad-ref', `${at} is a sha256 in lowercase hex`, at)
    } else if (typeof value !== 'string' || !subject.test(value)) {
      throw refuse('bad-ref', `${at} does not match ${subject.source}`, at)
    }
  }
}

function sameToken (header, token) {
  const given = Buffer.from(header ?? '', 'utf8')
  const expected = Buffer.from(`Bearer ${token}`, 'utf8')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

async function bodyOf (req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size <= MAX_BODY) chunks.push(chunk)
  }
  if (size > MAX_BODY) throw refuse('too-large', `the request is ${size} bytes, past ${MAX_BODY}`, String(size))
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
 * One cairn's daemon: HTTP on a unix socket, `POST /append` only. Who writes comes from the
 * `X-Cairn-*` headers and the instance file, never from the body, and every request carries the
 * cairn's token. An instance file that differs from the last `cairn.config` entry is recorded
 * as a new one before the socket opens.
 */
export async function serve ({ name, instanceFile, file, socket, token }) {
  const { instance, members, kinds, subjects } = readInstance(instanceFile)
  await claimSocket(socket)
  const cairn = openCairn(file, { name })
  const recorded = cairn.latest('cairn.config')
  if (!recorded || canonical(recorded.data) !== canonical(instance)) {
    cairn.append({
      at: new Date().toISOString(),
      kind: 'cairn.config',
      refs: {},
      data: instance,
      actor: { name: 'cairn', role: 'cairn', via: 'program' },
      id: null,
      hop: 0
    })
  }

  async function append (req) {
    const actor = req.headers['x-cairn-actor']
    if (actor === undefined || !Object.hasOwn(members, actor)) throw refuse('not-a-member', `${actor ?? 'a writer with no X-Cairn-Actor'} is not a member of ${name}`, actor ?? '')
    const via = req.headers['x-cairn-via']
    if (!VIA.has(via)) throw refuse('shape-mismatch', 'X-Cairn-Via is agent, program or cli', '$.actor.via')
    const hop = req.headers['x-cairn-hop']
    if (!/^\d+$/.test(hop ?? '') || !Number.isSafeInteger(Number(hop))) throw refuse('shape-mismatch', 'X-Cairn-Hop is a count', '$.hop')

    const body = await bodyOf(req)
    if (!isObject(body)) throw refuse('shape-mismatch', 'the request body is an object', '$')
    for (const key of Object.keys(body)) {
      if (!BODY_KEYS.has(key)) throw refuse('shape-mismatch', `${key} is not the writer's to send`, `$.${key}`)
    }
    if (!Object.hasOwn(kinds, body.kind)) throw refuse('unknown-kind', `${body.kind} is not a kind of ${name}`, String(body.kind))
    checkAt(body.at, Date.now())
    checkRefs(body.refs, subjects, cairn.head().seq)
    checkShape(kinds[body.kind], body.data, '$.data')
    const { expectedHead } = body
    if (expectedHead !== undefined && (!Number.isSafeInteger(expectedHead) || expectedHead < 0)) {
      throw refuse('shape-mismatch', 'expectedHead is the seq of the head the writer read', '$.expectedHead')
    }
    return cairn.append({
      at: body.at,
      kind: body.kind,
      refs: body.refs,
      data: body.data,
      actor: { name: actor, role: members[actor], via },
      id: req.headers['x-cairn-id'] ?? null,
      hop: Number(hop)
    }, { expectedHead, maxBytes: MAX_LINE })
  }

  async function handle (req) {
    if (!sameToken(req.headers.authorization, token)) throw refuse('unauthenticated', `a request to ${name} carries its token`, '')
    if (req.method === 'POST' && req.url === '/append') return [200, await append(req)]
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
    close: () => new Promise((resolve) => {
      server.close(() => {
        cairn.close()
        resolve()
      })
      server.closeAllConnections()
    })
  }
}
