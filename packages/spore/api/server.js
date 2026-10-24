/**
 * The library's verbs over HTTP, for a caller that is not on this machine or not in this
 * container: send, watch, show, list, stop, wrap, extend, the running turn as a person is shown it and
 * a line of the caller's own in it, and
 * approvals asked and read, and a program's delivery, prepared and timed as its spore says. Every
 * request names its caller by token and reaches only the spores that caller may; its
 * `traceparent` is the parent of the request's span, which a message carries on to its turn.
 * Contract: ARCHITECTURE.md, "The HTTP API".
 */

import { createServer } from 'node:http'
import { basename } from 'node:path'

import { isWorkspace } from '../src/library/discover.js'
import { CONFIG_FILE, NAME, readConfig, workspaceFor } from '../src/library/config.js'
import { list, show } from '../src/library/verbs.js'
import { watch } from '../src/library/watch.js'
import { annotateTurn, liveIn, renderLive } from '../src/library/live.js'
import { send } from '../src/core/send.js'
import { stop } from '../src/core/state.js'
import { extendTurn, wrapTurn } from '../src/core/limits.js'
import { approvalOf, approvalsIn, readEvents } from '../src/core/spore-dir.js'
import { askApproval } from '../src/library/approvals.js'
import { paused } from '../src/core/admission.js'
import { SporeError } from '../src/observability/errors.js'
import { endSpanError, endSpanOk, formatTraceparent, parseTraceparent, startSpan } from '../src/observability/tracing.js'
import { deliver } from '../src/core/route.js'
import { callerOf, reaches } from './config.js'

const MAX_BODY = 32 * 1024 * 1024
const ROUTE = /^\/v1\/spores(?:\/([^/]+)(?:\/(messages|deliveries|events|live|annotate|stop|wrap|extend|approvals)(?:\/([0-9a-f]{12}))?)?)?\/?$/
const DELIVERY = /^[A-Za-z0-9._:-]{1,128}$/
const LEVELS = ['brief', 'plain', 'details']
const PAYLOAD = 'payload.json'

const STATUS = {
  API_UNAUTHORIZED: 401,
  NOT_A_WORKSPACE: 404,
  API_NOT_FOUND: 404,
  API_METHOD: 405,
  API_TOO_LARGE: 413,
  ADMISSION_FULL: 503,
  PAUSED: 503,
  SPEND_LIMIT: 503
}

const failure = (type, message, detail) => new SporeError(message, { type, detail })

const briefingOf = (caller, delivery) => ({ payload }) => [
  `A delivery from "${caller}" through the API, delivery ${delivery}.`,
  payload ? `Its payload is ${payload} in your directory.` : 'It has no payload.'
].join('\n') + '\n'

function readBody (request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    request.on('data', chunk => {
      bytes += chunk.length
      if (bytes > MAX_BODY) {
        request.removeAllListeners('data')
        request.resume()
        reject(failure('API_TOO_LARGE', 'the request is larger than the API takes', `at most ${MAX_BODY} bytes`))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

async function jsonOf (request) {
  const body = await readBody(request)
  if (!body.length) return {}
  try {
    const parsed = JSON.parse(body.toString('utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {}
  throw failure('API_BAD_REQUEST', 'the request body is not a JSON object')
}

const attachmentsOf = (attach) => {
  if (attach === undefined) return []
  if (!Array.isArray(attach) || !attach.every(a => typeof a?.name === 'string' && typeof a?.mime === 'string' && typeof a?.data === 'string')) {
    throw failure('API_BAD_REQUEST', 'attach is not a list of files', '[{ "name", "mime", "data": "<base64>" }]')
  }
  return attach.map(a => ({ name: a.name, mime: a.mime, data: Buffer.from(a.data, 'base64') }))
}

/**
 * `api` is what `loadApi` read; `env` the environment a turn starts with, the API's tokens taken
 * out of it. `delivering` is what `deliver` takes to hold a delivery and run its router, for a test to replace.
 */
export function createApiServer ({ api, env, configFile = CONFIG_FILE, log = () => {}, pausedNow = paused, delivering = {} }) {
  const turnEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !api.secrets.has(key)))
  const routing = new Set()

  const deliveries = async ({ request, caller, ws, span }) => {
    const asked = await jsonOf(request)
    const pause = pausedNow()
    if (pause) throw failure('PAUSED', 'spores are paused', `since ${pause.at ?? 'spore pause'} — spore unpause lets deliveries in again`)
    const { delivery, text = '', payload, attach, ...rest } = asked
    const shape = '{ "delivery": "<your id for it>", "text": "…", "payload": <JSON>, "attach": [{ "name", "mime", "data": "<base64>" }] }'
    if (Object.keys(rest).length) throw failure('API_BAD_REQUEST', `a delivery is ${shape} — not ${Object.keys(rest).join(', ')}`)
    if (typeof delivery !== 'string' || !DELIVERY.test(delivery)) throw failure('API_BAD_REQUEST', 'delivery is your id for it, letters, digits, ., _, : and -, at most 128: the same id twice is delivered once', shape)
    if (typeof text !== 'string') throw failure('API_BAD_REQUEST', 'text is a string', shape)
    const files = attachmentsOf(attach)
    if (payload !== undefined && files.some(file => file.name === PAYLOAD)) throw failure('API_BAD_REQUEST', `${PAYLOAD} is the payload's name, and a file attached is called so too`, shape)
    if (!text.trim() && payload === undefined && !files.length) throw failure('API_BAD_REQUEST', 'a delivery carries a text, a payload or a file', shape)
    const options = {
      attach: [...(payload === undefined ? [] : [{ name: PAYLOAD, mime: 'application/json', data: Buffer.from(JSON.stringify(payload)) }]), ...files],
      api: caller.name,
      requestId: `api:${caller.name}:${delivery}`,
      traceparent: formatTraceparent(span) ?? undefined,
      env: turnEnv
    }
    const delivered = deliver({
      ws,
      said: text,
      options,
      maxWait: caller.maxWait,
      stdin: payload === undefined ? null : PAYLOAD,
      perDay: caller.perDay,
      perHour: caller.perHour,
      briefing: briefingOf(caller.name, delivery),
      ref: delivery,
      event: null,
      envOf: () => turnEnv,
      log,
      heading: `${caller.name} → ${basename(ws)} · ${delivery}`,
      ...delivering
    })
    routing.add(delivered.judged)
    delivered.judged.finally(() => routing.delete(delivered.judged))
    log(`${caller.name} → ${basename(ws)} · ${delivery} · ${delivered.outcome}`)
    return { status: 202, body: { delivery, outcome: delivered.outcome, started: delivered.started } }
  }

  const sporeOf = (caller, name) => {
    if (!NAME.test(name) || !reaches(caller, name)) throw failure('NOT_A_WORKSPACE', `no spore called "${name}"`)
    const target = workspaceFor(name, { file: configFile })
    if (!isWorkspace(target.path)) throw failure('NOT_A_WORKSPACE', `no spore called "${name}"`)
    return target.path
  }

  const routes = {
    'GET spores': ({ caller }) => {
      const { home } = readConfig(configFile)
      const reached = list({ configFile }).workspaces
        .filter(row => row.from === home)
        .map(row => ({ name: basename(row.ws), state: row.state, turns: row.lastTurnNo }))
        .filter(row => reaches(caller, row.name))
      return { status: 200, body: { spores: reached } }
    },
    'GET spore': ({ ws }) => ({ status: 200, body: show({ ws, configFile }) }),
    'GET live': ({ ws, url }) => {
      const level = url.searchParams.get('level') ?? 'plain'
      if (!LEVELS.includes(level)) throw failure('API_BAD_REQUEST', `level is ${LEVELS.join(', ')} — not ${level}`)
      const running = liveIn(ws)
      if (!running) return { status: 200, body: { live: null, lines: [], seq: null } }
      return { status: 200, body: { live: running.live, lines: renderLive(running.live, { level }), seq: running.seq } }
    },
    'POST messages': async ({ request, ws, span }) => {
      const asked = await jsonOf(request)
      if (typeof asked.text !== 'string' || !asked.text.trim()) throw failure('API_BAD_REQUEST', 'a message needs its text', '{ "text": "…" }')
      const sent = send(ws, asked.text, {
        attach: attachmentsOf(asked.attach),
        requestId: asked.requestId,
        replyTo: asked.replyTo,
        from: asked.from,
        traceparent: formatTraceparent(span) ?? undefined,
        env: turnEnv
      })
      return { status: 202, body: { inbox: sent.inbox, started: sent.started, repeated: Boolean(sent.repeated) } }
    },
    'POST approvals': async ({ request, ws }) => ({ status: 201, body: askApproval(ws, await jsonOf(request), { configFile }) }),
    'GET approvals': ({ ws }) => ({ status: 200, body: { approvals: approvalsIn(ws) } }),
    'GET approval': ({ ws, id }) => {
      const one = approvalOf(ws, id)
      if (!one) throw failure('API_NOT_FOUND', `no approval ${id} in this spore`)
      return { status: 200, body: one }
    },
    'POST annotate': async ({ request, ws }) => ({ status: 200, body: annotateTurn(ws, (await jsonOf(request)).text) }),
    'POST stop': ({ ws }) => ({ status: 200, body: stop(ws) }),
    'POST wrap': async ({ request, ws }) => ({ status: 200, body: wrapTurn(ws, (await jsonOf(request)).wait) }),
    'POST extend': async ({ request, ws }) => {
      const { dimension, amount } = await jsonOf(request)
      return { status: 200, body: extendTurn(ws, dimension, String(amount)) }
    }
  }

  const events = async ({ request, response, ws, url }) => {
    const after = Number(url.searchParams.get('after') ?? 0)
    if (!Number.isInteger(after) || after < 0) throw failure('API_BAD_REQUEST', 'after is the seq of the last event seen, a whole number')
    response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
    if (url.searchParams.get('follow') === 'false') {
      for (const event of readEvents(ws, { after })) response.write(JSON.stringify(event) + '\n')
      response.end()
      return
    }
    const leaving = new AbortController()
    request.on('close', () => leaving.abort())
    for await (const event of watch(ws, { after, signal: leaving.signal })) response.write(JSON.stringify(event) + '\n')
    response.end()
  }

  const answer = (response, status, body, traceparent) => {
    response.writeHead(status, { 'content-type': 'application/json', ...(traceparent ? { traceparent } : {}) })
    response.end(JSON.stringify(body))
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://spore')
    const found = ROUTE.exec(url.pathname)
    const [, name, action, id] = found ?? []
    const route = !found || (id && action !== 'approvals') ? null : !name ? 'spores' : id ? 'approval' : action ?? 'spore'
    const span = startSpan(`spore.api.${route ?? 'unknown'}`, { 'http.method': request.method, ...(name ? { 'spore.name': name } : {}) }, parseTraceparent(request.headers.traceparent))
    const traceparent = formatTraceparent(span)
    let caller = null
    try {
      caller = callerOf(api.callers, /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1])
      if (!caller) throw failure('API_UNAUTHORIZED', 'no token, or not one this API knows', 'Authorization: Bearer <token>')
      span.setAttribute('spore.api.caller', caller.name)
      if (!route) throw failure('API_NOT_FOUND', `${request.method} ${url.pathname} is not a route of this API`, 'see INTEGRATION.md, "The HTTP API"')
      const ws = name ? sporeOf(caller, decodeURIComponent(name)) : null
      if (route === 'events') {
        if (request.method !== 'GET') throw failure('API_METHOD', `events are read with GET, not ${request.method}`)
        await events({ request, response, ws, url })
        endSpanOk(span)
        return
      }
      const handle = route === 'deliveries' ? request.method === 'POST' && deliveries : routes[`${request.method} ${route}`]
      if (!handle) throw failure('API_METHOD', `${request.method} is not how ${route} is asked`)
      const { status, body } = await handle({ request, caller, ws, id, span, url })
      answer(response, status, body, traceparent)
      endSpanOk(span, { 'http.status_code': status })
      log(`${caller.name} · ${request.method} ${url.pathname} · ${status}`)
    } catch (err) {
      const status = STATUS[err.type] ?? (err instanceof SporeError ? 400 : 500)
      endSpanError(span, err)
      log(`${caller?.name ?? 'unknown'} · ${request.method} ${url.pathname} · ${status} ${err.type ?? err.message}`)
      if (response.headersSent) {
        response.end()
        return
      }
      if (err.type === 'API_TOO_LARGE') {
        response.setHeader('connection', 'close')
        response.once('finish', () => request.destroy())
      }
      answer(response, status, { error: { type: err.type ?? 'API_FAILED', message: err.message, ...(err.detail ? { detail: err.detail } : {}) } }, traceparent)
    }
  })
  return Object.assign(server, { routed: () => Promise.all([...routing]) })
}
