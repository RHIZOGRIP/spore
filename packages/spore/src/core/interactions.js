/**
 * Interactions: something a spore asks of a handler the operator describes in `config.json` — a
 * service at a URL or a program on this host — whose result comes back later as a message. The
 * runner freezes the agent's data into `interactions/<id>/` and stamps the turn, the inbox it read
 * and the route; this side hashes the data, records the interaction and hands it to its handler —
 * for the runner's helper (`bin/spore-interaction.js`) and for `spore tick`, which hands over what
 * the runner could not — and takes the outcome back, from `spore-api` or `spore interaction
 * outcome`. Contract: docs/interactions.md.
 */

import { spawn } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve as resolvePath } from 'node:path'

import { CONFIG_FILE, readConfig, workspaceFor } from '../library/config.js'
import { askInteraction, cancelInteraction as cancelRecorded, handInteraction as handRecorded, interactionOf, interactionsIn, sayOutcome } from './spore-dir.js'
import { wake } from './send.js'
import { variableOf } from './variables.js'
import { SporeError } from '../observability/errors.js'

export const PROTOCOL_VERSION = 1
export const INTERACTIONS_DIR = 'interactions'
const URL_TIMEOUT_MS = 30_000
const PROGRAM_TIMEOUT_MS = 60_000
const NOT_NOW = 75
const OPEN = ['asked', 'handed']

const refusal = (status, type, message, detail) => Object.assign(new SporeError(message, { type, detail }), { status })

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * `value` serialized by the JSON Canonicalization Scheme (RFC 8785). JavaScript's own number and
 * string serialization are the ones it specifies, and a sort with no comparator orders keys by
 * UTF-16 code units, as it asks.
 */
export function canonical (value) {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`${value} has no JSON form`)
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')

const byUtf8 = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))

function filesUnder (root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    return entry.isDirectory() ? filesUnder(root, path) : [path]
  })
}

/**
 * The data frozen at `dir`, as the request carries it — one `{ path, bytes, sha256, data }` per
 * file in UTF-8 path order, `data` in base64 — and its hash, over the handler and every file but
 * its bytes.
 */
export function dataOf (dir, handler) {
  const files = filesUnder(dir).sort(byUtf8).map(path => {
    const bytes = readFileSync(join(dir, path))
    return { path, bytes: bytes.length, sha256: sha256(bytes), data: bytes.toString('base64') }
  })
  const listed = files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
  return { files, dataHash: sha256(canonical({ handler, files: listed })) }
}

export function handlerOf (name, { configFile = CONFIG_FILE, env }) {
  const described = readConfig(configFile).interactions?.[name]
  if (!described) {
    throw refusal(409, 'INTERACTION_HANDLER', `this host describes no handler ${name}`, `its operator describes one under interactions in ${configFile}`)
  }
  if (described.program) return { name, program: described.program }
  const variable = variableOf(described.secret)
  if (!env[variable]) {
    throw refusal(409, 'INTERACTION_HANDLER', `the handler ${name} has no secret`, `its secret is $${variable}, which is not set — it goes in environment beside config.json`)
  }
  return { name, base: described.url.endsWith('/') ? described.url : `${described.url}/`, secret: env[variable] }
}

export function handlersFor (granted, { configFile = CONFIG_FILE } = {}) {
  const described = readConfig(configFile).interactions ?? {}
  return granted.map(name => {
    if (!described[name]) throw refusal(409, 'INTERACTION_HANDLER', `this host describes no handler ${name}`, `its operator describes one under interactions in ${configFile}`)
    return { name, what: described[name].what }
  })
}

export function signature (secret, method, path, body, now = Date.now()) {
  const at = String(Math.floor(now / 1000))
  const signed = createHmac('sha256', secret).update(`${at}.${method} ${path}.${body}`).digest('hex')
  return { 'x-spore-timestamp': at, 'x-spore-signature': `sha256=${signed}` }
}

const ROUTES = {
  create: (id) => ['POST', 'v1/interactions'],
  state: (id) => ['GET', `v1/interactions/${id}`],
  cancel: (id) => ['POST', `v1/interactions/${id}/cancel`]
}

const refusalIn = (answer) => isRecord(answer) && typeof answer.type === 'string' && typeof answer.message === 'string'
  ? { type: answer.type, message: answer.message, detail: typeof answer.detail === 'string' ? answer.detail : '' }
  : null

async function callUrl (handler, verb, payload) {
  const [method, route] = ROUTES[verb](payload.id)
  const url = new URL(route, handler.base)
  const body = method === 'GET' ? '' : JSON.stringify(payload)
  let response
  try {
    response = await fetch(url, {
      method,
      headers: { ...signature(handler.secret, method, url.pathname, body), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(URL_TIMEOUT_MS)
    })
  } catch (err) {
    return { unreachable: `${url.origin} could not be reached — ${err.cause?.code ?? err.message}` }
  }
  if (response.status >= 500) return { unreachable: `${url.origin} answered ${response.status}` }
  const text = await response.text()
  let answer
  try {
    answer = text ? JSON.parse(text) : null
  } catch {
    return { refused: { type: 'INTERACTION_HANDLER_REFUSED', message: `${method} ${url.pathname} answered ${response.status} with what is not JSON`, detail: text.slice(0, 200) } }
  }
  if (response.status === 200 || response.status === 201) return { answer }
  return { refused: refusalIn(answer) ?? { type: 'INTERACTION_HANDLER_REFUSED', message: `${method} ${url.pathname} answered ${response.status}`, detail: JSON.stringify(answer)?.slice(0, 200) ?? '' } }
}

function callProgram (handler, verb, payload, env) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(handler.program, [verb], { cwd: homedir(), env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    } catch (err) {
      resolve({ refused: { type: 'INTERACTION_HANDLER_REFUSED', message: `${handler.program} could not be started`, detail: err.message } })
      return
    }
    const out = []
    const err = []
    child.stdout.on('data', chunk => out.push(chunk))
    child.stderr.on('data', chunk => err.push(chunk))
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (e) {
        if (e.code !== 'ESRCH') throw e
      }
      resolve({ unreachable: `${handler.program} did not answer within ${PROGRAM_TIMEOUT_MS / 1000}s` })
    }, PROGRAM_TIMEOUT_MS)
    child.on('error', e => {
      clearTimeout(timer)
      resolve({ refused: { type: 'INTERACTION_HANDLER_REFUSED', message: `${handler.program} could not be started`, detail: e.message } })
    })
    child.on('close', code => {
      clearTimeout(timer)
      const line = Buffer.concat(out).toString().trim().split('\n').at(-1) ?? ''
      const lastErr = Buffer.concat(err).toString().trim().split('\n').at(-1) ?? ''
      let answer = null
      try {
        answer = line ? JSON.parse(line) : null
      } catch {}
      if (code === NOT_NOW) return resolve({ unreachable: `${handler.program} ${verb} exited ${NOT_NOW}, not now${lastErr ? ` — ${lastErr}` : ''}` })
      if (code === 0 && answer !== null) return resolve({ answer })
      if (code === 0) return resolve({ refused: { type: 'INTERACTION_HANDLER_REFUSED', message: `${handler.program} ${verb} printed no JSON line`, detail: line.slice(0, 200) } })
      resolve({ refused: refusalIn(answer) ?? { type: 'INTERACTION_HANDLER_REFUSED', message: `${handler.program} ${verb} exited ${code}`, detail: lastErr } })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(payload))
  })
}

/**
 * One request to a handler: `{ answer }`, `{ refused: { type, message, detail } }`, or
 * `{ unreachable }` — a network failure, a 5xx, a program that exited 75 or ran too long — which a
 * later handoff tries again.
 */
function callHandler (handler, verb, payload, env) {
  return handler.program ? callProgram(handler, verb, payload, env) : callUrl(handler, verb, payload)
}

const handlerRefused = (handler, verb, refused) => refusal(409, 'INTERACTION_HANDLER_REFUSED', `the handler ${handler.name} refused ${verb}`,
  [refused.type, refused.message, refused.detail].filter(Boolean).join(' — '))

/**
 * The name an outcome reaches the spore at `ws` by: its directory's, when that name under home is
 * this workspace. An outcome sent to any other name would find no spore.
 */
export function reachedAs (ws, { configFile = CONFIG_FILE } = {}) {
  const name = basename(ws)
  let reached = null
  try {
    reached = workspaceFor(name, { file: configFile }).path
  } catch (err) {
    if (!['CONFIG_NO_HOME', 'CONFIG_BAD_NAME'].includes(err.type)) throw err
  }
  if (reached === null || resolvePath(reached) !== resolvePath(ws)) {
    throw refusal(409, 'INTERACTIONS_UNREACHABLE', 'an outcome cannot reach this spore by name', `spore-api and spore interaction outcome reach a spore by its name under home; ${ws} is not ${name} under home`)
  }
  return name
}

const described = (row) => ({ id: row.id, handler: row.handler, dataHash: row.dataHash, state: row.state, ...(row.link === null ? {} : { link: row.link }) })

function expiresOf (given, now) {
  if (given === undefined || given === null) return null
  const at = new Date(given)
  if (Number.isNaN(at.getTime()) || !/^\d{4}-\d\d-\d\dT/.test(given)) throw refusal(400, 'INTERACTION_EXPIRES', `${given} is not an instant`, 'expires is an ISO 8601 instant, as 2027-03-01T12:00:00Z, or left out for never')
  if (at.getTime() <= now) throw refusal(400, 'INTERACTION_EXPIRES', `${given} has passed`, 'expires is an instant still to come, or left out for never')
  return at.toISOString()
}

const unknown = (id) => refusal(404, 'INTERACTION_UNKNOWN', `this spore holds no interaction ${id}`, 'its id is the one create answered')

/**
 * The asked interaction `id` handed to its handler, recorded `handed` once the handler took it.
 * One the handler could not take now stays `asked`, answered with `unreachable`, for a later
 * handoff; the handler keys on the id, so handing one over twice makes it once.
 */
export async function handOver (ws, id, { configFile = CONFIG_FILE, env }) {
  const row = interactionOf(ws, id)
  if (!row) throw unknown(id)
  if (row.state !== 'asked') return described(row)
  const handler = handlerOf(row.handler, { configFile, env })
  const frozen = join(ws, INTERACTIONS_DIR, id)
  const kept = dataOf(frozen, row.handler)
  if (kept.dataHash !== row.dataHash) {
    throw refusal(500, 'INTERACTION_FAILED', `the data kept for ${id} no longer hashes to what was recorded`, `${frozen} was changed after it was frozen`)
  }
  const request = {
    v: row.v,
    id,
    handler: row.handler,
    spore: reachedAs(ws, { configFile }),
    route: row.route,
    origin: JSON.parse(row.origin),
    askedAt: row.askedAt,
    expires: row.expires,
    supersedes: row.supersedes,
    dataHash: row.dataHash,
    files: kept.files
  }
  const called = await callHandler(handler, 'create', request, env)
  if (called.unreachable) return { ...described(row), unreachable: called.unreachable }
  if (called.refused) throw handlerRefused(handler, 'create', called.refused)
  const { answer } = called
  if (!isRecord(answer) || answer.id !== id || answer.state !== 'pending' || (answer.link !== undefined && typeof answer.link !== 'string')) {
    throw refusal(502, 'INTERACTION_HANDLER_REFUSED', `the handler ${handler.name} took it and answered what the protocol does not say`, `expected { id, state: "pending", link? } — got ${JSON.stringify(answer)?.slice(0, 200)}`)
  }
  handRecorded(ws, id, answer.link ?? null)
  return described(interactionOf(ws, id))
}

/**
 * An interaction asked of `handler` from the data frozen at `interactions/<id>/`, under what the
 * runner stamped: `turnId`, `route`, `origin`, and `most`, the grant. Recorded before it is handed
 * over, so one the handler never confirmed is still known; the frozen data is removed when nothing
 * was recorded under its id.
 */
export async function createInteraction (ws, { handler, id, turnId, route, origin, most, key = null, supersedes = null, expires, configFile = CONFIG_FILE, env, now = Date.now() }) {
  const frozen = join(ws, INTERACTIONS_DIR, id)
  let asked
  try {
    handlerOf(handler, { configFile, env })
    reachedAs(ws, { configFile })
    const kept = dataOf(frozen, handler)
    asked = askInteraction(ws, {
      id,
      key,
      v: PROTOCOL_VERSION,
      handler,
      dataHash: kept.dataHash,
      route,
      origin,
      turnId,
      askedAt: new Date(now).toISOString(),
      expires: expiresOf(expires, now),
      supersedes
    }, most)
  } catch (err) {
    rmSync(frozen, { recursive: true })
    throw err
  }
  if (asked.refused || asked.repeated) rmSync(frozen, { recursive: true })
  if (asked.refused === 'key') throw refusal(409, 'INTERACTION_KEY_REUSED', `the key ${key} was used for other data`, 'the same key with the same data answers the interaction already made; changed data is a new interaction, with --supersedes')
  if (asked.refused === 'full') throw refusal(409, 'INTERACTIONS_TURN_FULL', `this turn has asked ${asked.made} interactions, all its grant allows`, `spore.cmk grants interactions: ${most} per turn`)
  if (asked.refused === 'supersedes') {
    throw asked.state === null
      ? unknown(supersedes)
      : refusal(409, 'INTERACTION_CLOSED', `${supersedes} is ${asked.state}, no longer open`, 'only an asked or handed interaction is superseded')
  }
  return { ...(await handOver(ws, asked.repeated ? asked.id : id, { configFile, env })), ...(asked.repeated ? { repeated: true } : {}) }
}

export async function interactionStatus (ws, id, { configFile = CONFIG_FILE, env }) {
  const row = interactionOf(ws, id)
  if (!row) throw unknown(id)
  const record = { ...described(row), route: row.route, askedAt: row.askedAt, expires: row.expires, endedAt: row.endedAt, processed: Boolean(row.processed) }
  if (row.state === 'asked') return record
  const called = await callHandler(handlerOf(row.handler, { configFile, env }), 'state', { v: row.v, id }, env)
  return { ...record, said: called.answer ?? (called.refused ? { refused: called.refused } : { unreachable: called.unreachable }) }
}

export const interactionList = (ws) => interactionsIn(ws).map(row => ({ ...described(row), askedAt: row.askedAt, endedAt: row.endedAt }))

/**
 * The open interaction `id` cancelled. A handler at a URL decides: it is recorded once the handler
 * confirms it, or says it holds no such id for one never handed over. A program need not handle a
 * cancel, so one that refuses it, but for having it answered first, is cancelled all the same, and
 * its later outcome refused.
 */
export async function cancelOne (ws, id, { configFile = CONFIG_FILE, env }) {
  const row = interactionOf(ws, id)
  if (!row) throw unknown(id)
  if (!OPEN.includes(row.state)) throw refusal(409, 'INTERACTION_CLOSED', `${id} is ${row.state}, no longer open`, 'only an asked or handed interaction is cancelled')
  const handler = handlerOf(row.handler, { configFile, env })
  const called = await callHandler(handler, 'cancel', { v: row.v, id }, env)
  if (called.unreachable) throw refusal(503, 'INTERACTION_HANDLER_REFUSED', `the handler ${handler.name} could not take the cancel now`, called.unreachable)
  const refused = called.refused
  if (refused?.type === 'INTERACTION_ANSWERED') throw refusal(409, 'INTERACTION_ANSWERED', `${id} was answered before it was cancelled`, 'its outcome comes to this spore as a message')
  const neverHanded = row.state === 'asked' && refused?.type === 'INTERACTION_UNKNOWN'
  if (refused && !neverHanded && !handler.program) throw handlerRefused(handler, 'cancel', refused)
  cancelRecorded(ws, id)
  return { ...described(interactionOf(ws, id)), ...(refused ? { said: { refused } } : {}) }
}

export async function handAsked (ws, { configFile = CONFIG_FILE, env }) {
  const handed = []
  const waiting = []
  const refused = []
  for (const row of interactionsIn(ws, { state: 'asked' })) {
    try {
      const done = await handOver(ws, row.id, { configFile, env })
      if (done.unreachable) waiting.push({ id: row.id, unreachable: done.unreachable })
      else handed.push(row.id)
    } catch (err) {
      refused.push({ id: row.id, type: err.type, detail: err.detail ?? err.message })
    }
  }
  return { handed, waiting, refused }
}

const ANSWER_FILE = 'answer.json'
const SUBMITTED_KEYS = ['v', 'outcome', 'dataHash', 'answer', 'attachments', 'responder', 'submittedAt', 'receipt']
const OPTIONAL_KEYS = ['responder']
const EXPIRED_KEYS = ['v', 'outcome', 'dataHash', 'at']
const HEX = /^[0-9a-f]{64}$/

const outcomeRefused = (detail) => refusal(400, 'INTERACTION_OUTCOME', 'the outcome does not match what this spore asked', detail)

const isInstant = (text) => typeof text === 'string' && /^\d{4}-\d\d-\d\dT/.test(text) && !Number.isNaN(new Date(text).getTime())

/**
 * The receipt a submitted outcome carries: a checksum over what was submitted, by whom and when.
 * `responder` is optional in an outcome, and stands as null in the receipt when it is absent.
 */
export function receiptOf ({ v, id, dataHash, answer, attachments, responder = null, submittedAt }) {
  const listed = attachments.map(({ name, sha256 }) => ({ name, sha256 })).sort((a, b) => byUtf8(a.name, b.name))
  return sha256(canonical({ v, id, dataHash, answer: sha256(canonical(answer)), attachments: listed, responder, submittedAt }))
}

function checkedAttachments (attachments) {
  if (!Array.isArray(attachments)) throw outcomeRefused('attachments is a list, empty when nothing is attached')
  const names = new Set([ANSWER_FILE])
  return attachments.map((one, i) => {
    const { name, mime, sha256: hash, data } = one ?? {}
    const shaped = typeof name === 'string' && name && Buffer.byteLength(name) <= 255 && !name.includes('/') && name !== '.' && name !== '..' &&
      typeof mime === 'string' && mime && typeof hash === 'string' && HEX.test(hash) && typeof data === 'string' && Object.keys(one).length === 4
    if (!shaped) throw outcomeRefused(`attachment ${i} is not { name, mime, sha256, data } with a name of at most 255 bytes and no /`)
    if (names.has(name)) throw outcomeRefused(`attachment ${i} is called ${JSON.stringify(name)}, which another file of this outcome is called`)
    names.add(name)
    const bytes = Buffer.from(data, 'base64')
    if (sha256(bytes) !== hash) throw outcomeRefused(`attachment ${JSON.stringify(name)} does not hash to its sha256`)
    return { name, mime, sha256: hash, data: bytes }
  })
}

/**
 * The handler's outcome for the interaction `id` in the spore at `ws`, checked against spore's own
 * record and said to the spore, and a turn started to read it: `{ inbox, repeated }`. Written
 * before it is answered, so a lost answer is a repeat that finds the same entry; a turn that cannot
 * start yet is refused with the outcome kept, and the repeat starts it.
 */
export function takeOutcome (ws, id, body, { env, configFile = CONFIG_FILE }) {
  const row = interactionOf(ws, id)
  if (!row) throw refusal(404, 'INTERACTION_UNKNOWN', `this spore holds no interaction ${id}`, 'an outcome names an interaction this spore asked for')
  if (!isRecord(body)) throw outcomeRefused('the outcome is a JSON object')
  if (body.v !== row.v) throw outcomeRefused(`${id} was asked under version ${row.v}, and the outcome says ${JSON.stringify(body.v)}`)
  if (!['submitted', 'expired'].includes(body.outcome)) throw outcomeRefused(`outcome is submitted or expired, not ${JSON.stringify(body.outcome)}`)
  const keys = body.outcome === 'submitted' ? SUBMITTED_KEYS : EXPIRED_KEYS
  const stray = Object.keys(body).filter(key => !keys.includes(key))
  const missing = keys.filter(key => body[key] === undefined && !OPTIONAL_KEYS.includes(key))
  if (stray.length || missing.length) throw outcomeRefused(`an outcome ${body.outcome} is { ${keys.join(', ')} }${stray.length ? ` — not ${stray.join(', ')}` : ''}${missing.length ? ` — ${missing.join(', ')} missing` : ''}`)
  if (body.dataHash !== row.dataHash) throw outcomeRefused(`${id} was asked with the data ${row.dataHash}, and the outcome names ${body.dataHash}`)

  let receipt = null
  let attachments = []
  let said
  if (body.outcome === 'submitted') {
    const { responder, submittedAt } = body
    if (responder !== undefined && !isRecord(responder)) throw outcomeRefused('responder is an object saying who or what answered, or left out')
    if (!isInstant(submittedAt)) throw outcomeRefused('submittedAt is an ISO 8601 instant')
    attachments = checkedAttachments(body.attachments)
    if (typeof body.receipt !== 'string' || !HEX.test(body.receipt)) throw outcomeRefused('receipt is a SHA-256 in lowercase hex')
    receipt = receiptOf({ v: body.v, id, dataHash: body.dataHash, answer: body.answer, attachments, responder, submittedAt })
    if (receipt !== body.receipt) throw outcomeRefused('the receipt does not recompute from the outcome')
    const files = attachments.length ? `, with ${attachments.length === 1 ? 'one file' : `${attachments.length} files`} beside it` : ''
    const by = responder === undefined ? '' : `, answered by ${JSON.stringify(responder)}`
    said = `Asked of ${row.handler} at ${row.askedAt}, submitted ${submittedAt}${by}. What it carries is ${ANSWER_FILE}${files}.`
  } else {
    if (!isInstant(body.at)) throw outcomeRefused('at is the ISO 8601 instant it expired')
    said = `Asked of ${row.handler} at ${row.askedAt}, expired unanswered at ${body.at}.`
  }

  if (!OPEN.includes(row.state)) {
    if (row.state === body.outcome && row.receipt === receipt) {
      readSoon(ws, id, { env, configFile })
      return { inbox: row.answeredInbox, repeated: true }
    }
    throw refusal(409, row.state === 'cancelled' || row.state === 'superseded' ? 'INTERACTION_CLOSED' : 'INTERACTION_ANSWERED', `${id} is ${row.state} already`, 'the first outcome recorded is the one the spore has')
  }
  const attach = body.outcome === 'submitted'
    ? [{ name: ANSWER_FILE, mime: 'application/json', data: Buffer.from(JSON.stringify(body.answer, null, 2) + '\n') }, ...attachments.map(({ name, mime, data }) => ({ name, mime, data }))]
    : []
  const told = sayOutcome(ws, id, { outcome: body.outcome, receipt, said, attach })
  if (told.refused === 'unknown') throw refusal(404, 'INTERACTION_UNKNOWN', `this spore holds no interaction ${id}`, 'an outcome names an interaction this spore asked for')
  if (told.refused) throw refusal(409, told.refused === 'ended' ? 'INTERACTION_CLOSED' : 'INTERACTION_ANSWERED', `${id} is ${told.state} already`, 'the first outcome recorded is the one the spore has')
  readSoon(ws, id, { env, configFile })
  return { inbox: told.inbox, repeated: told.repeated }
}

function readSoon (ws, id, { env, configFile }) {
  if (!interactionOf(ws, id).processed) wake(ws, { env, configFile })
}
