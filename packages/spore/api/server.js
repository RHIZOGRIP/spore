/**
 * The library's verbs over HTTP, for a caller that is not on this machine or not in this
 * container: send, watch, show, list, stop, wrap, extend, flush, the running turn as a person is shown it and
 * a line of the caller's own in it, approvals asked, read and, for the kinds of place the caller serves, shown and answered, a program's delivery, prepared and timed as its spore says, and the
 * outcome of an interaction the spore asked for, from the handler that took it. Every
 * request names its caller by token and reaches only the spores that caller may; its
 * `traceparent` is the parent of the request's span, which a message carries on to its turn.
 * Contract: ARCHITECTURE.md, "The HTTP API".
 */

import { createServer } from 'node:http'
import { basename } from 'node:path'

import { isWorkspace } from '../src/library/discover.js'
import { CONFIG_FILE, NAME, readConfig, workspaceFor } from '../src/library/config.js'
import { flush, list, show } from '../src/library/verbs.js'
import { watch } from '../src/library/watch.js'
import { annotateTurn, liveIn, renderLive } from '../src/library/live.js'
import { send } from '../src/core/send.js'
import { stop } from '../src/core/state.js'
import { native } from '../src/native.js'
import { extendTurn, wrapTurn } from '../src/core/limits.js'
import { approvalOf, approvalsIn, expireApproval, postApproval, readEvents, refuseApproval, settleApproval } from '../src/core/spore-dir.js'
import { answerApproval, askApproval, endedText } from '../src/library/approvals.js'
import { paused } from '../src/core/admission.js'
import { SporeError } from '../src/observability/errors.js'
import { readBody } from '../src/infra/http.js'
import { endSpanError, endSpanOk, formatTraceparent, parseTraceparent, startSpan } from '../src/observability/tracing.js'
import { deliver } from '../src/core/route.js'
import { takeOutcome } from '../src/core/interactions.js'
import { callerOf, reaches } from './config.js'

const MAX_BODY = 32 * 1024 * 1024
const ROUTE = /^\/v1\/spores(?:\/([^/]+)(?:\/(messages|deliveries|events|live|annotate|stop|wrap|extend|flush|approvals)(?:\/([0-9a-f]{12})(?:\/(posted|refused|answer|settled))?)?)?)?\/?$/
const OUTCOME = /^\/v1\/spores\/([^/]+)\/interactions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/outcome\/?$/
const DELIVERY = /^[A-Za-z0-9._:-]{1,128}$/
const LEVELS = ['brief', 'plain', 'details']
const PAYLOAD = 'payload.json'
const OUTCOMES = ['confirmed', 'failed']
const LATE = 'its deadline passed before it could be shown'

const STATUS = {
  API_UNAUTHORIZED: 401,
  NOT_A_WORKSPACE: 404,
  API_NOT_FOUND: 404,
  API_METHOD: 405,
  API_TOO_LARGE: 413,
  ADMISSION_FULL: 503,
  PAUSED: 503,
  SPORE_RUNNING: 409,
  SPORE_CRASHED: 409,
  APPROVAL_NOT_SERVED: 403,
  APPROVAL_STATE: 409,
  APPROVAL_HOOKED: 409,
  INTERACTION_UNKNOWN: 404,
  INTERACTION_ANSWERED: 409,
  INTERACTION_CLOSED: 409
}

const failure = (type, message, detail) => new SporeError(message, { type, detail })

const briefingOf = (caller, delivery) => ({ payload }) => [
  `A delivery from "${caller}" through the API, delivery ${delivery}.`,
  payload ? `Its payload is ${payload} in your directory.` : 'It has no payload.'
].join('\n') + '\n'

async function jsonOf (request, response) {
  const body = await readBody(request, response, MAX_BODY)
  if (body === null) throw failure('API_TOO_LARGE', 'the request is larger than the API takes', `at most ${MAX_BODY} bytes`)
  if (!body.length) return {}
  try {
    const parsed = JSON.parse(body.toString('utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch {}
  throw failure('API_BAD_REQUEST', 'the request body is not a JSON object')
}

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value) => typeof value === 'string' && value.trim() !== ''
const kindOfPlace = (approval) => approval.place.slice(0, approval.place.indexOf(':'))
const due = (approval) => Date.parse(approval.until) <= Date.now()

/**
 * An approval past its deadline ended, which nothing but a look at it does for a place a caller
 * serves: one never shown is refused and done with, one shown and not answered expires.
 */
function ended (ws, approval) {
  if (!due(approval) || !['asked', 'posted'].includes(approval.state)) return approval
  if (approval.state === 'posted') expireApproval(ws, approval.id)
  else if (refuseApproval(ws, approval.id, LATE)) settleApproval(ws, approval.id)
  return approvalOf(ws, approval.id)
}

const attachmentsOf = (attach) => {
  if (attach === undefined) return []
  if (!Array.isArray(attach) || !attach.every(a => typeof a?.name === 'string' && typeof a?.mime === 'string' && typeof a?.data === 'string')) {
    throw failure('API_BAD_REQUEST', 'attach is not a list of files', '[{ "name", "mime", "data": "<base64>" }]')
  }
  return attach.map(a => ({ name: a.name, mime: a.mime, data: Buffer.from(a.data, 'base64') }))
}

/**
 * `api` is what `loadApi` read; `env` the environment the service was started with, which a turn
 * starts from.
 */
export function createApiServer ({ api, env, log = () => {} }) {
  const routing = new Set()

  const deliveries = async ({ request, response, caller, ws, span }) => {
    const asked = await jsonOf(request, response)
    const pause = paused()
    if (pause) throw failure('PAUSED', 'spores are paused', `since ${pause.at ?? 'spore pause'} — spore unpause lets deliveries in again`)
    const { delivery, text = '', payload, attach, hop, ...rest } = asked
    const shape = '{ "delivery": "<your id for it>", "text": "…", "payload": <JSON>, "attach": [{ "name", "mime", "data": "<base64>" }], "hop": <count> }'
    if (Object.keys(rest).length) throw failure('API_BAD_REQUEST', `a delivery is ${shape} — not ${Object.keys(rest).join(', ')}`)
    if (typeof delivery !== 'string' || !DELIVERY.test(delivery)) throw failure('API_BAD_REQUEST', 'delivery is your id for it, letters, digits, ., _, : and -, at most 128: the same id twice is delivered once', shape)
    if (typeof text !== 'string') throw failure('API_BAD_REQUEST', 'text is a string', shape)
    if (hop !== undefined && !(Number.isSafeInteger(hop) && hop >= 0)) throw failure('API_BAD_REQUEST', 'hop is how many deliveries led to this one, a whole number from 0', shape)
    const files = attachmentsOf(attach)
    if (payload !== undefined && files.some(file => file.name === PAYLOAD)) throw failure('API_BAD_REQUEST', `${PAYLOAD} is the payload's name, and a file attached is called so too`, shape)
    if (!text.trim() && payload === undefined && !files.length) throw failure('API_BAD_REQUEST', 'a delivery carries a text, a payload or a file', shape)
    const options = {
      attach: [...(payload === undefined ? [] : [{ name: PAYLOAD, mime: 'application/json', data: Buffer.from(JSON.stringify(payload)) }]), ...files],
      api: caller.name,
      ...(hop === undefined ? {} : { hop }),
      requestId: `api:${caller.name}:${delivery}`,
      traceparent: formatTraceparent(span) ?? undefined,
      env
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
      env,
      configFile: CONFIG_FILE,
      log,
      heading: `${caller.name} → ${basename(ws)} · ${delivery}`
    })
    routing.add(delivered.judged)
    delivered.judged.finally(() => routing.delete(delivered.judged))
    log(`${caller.name} → ${basename(ws)} · ${delivery} · ${delivered.outcome}`)
    return { status: 202, body: { delivery, outcome: delivered.outcome, started: delivered.started } }
  }

  const sporeOf = (caller, name) => {
    if (!NAME.test(name) || !reaches(caller, name)) throw failure('NOT_A_WORKSPACE', `no spore called "${name}"`)
    const target = workspaceFor(name, { file: CONFIG_FILE })
    if (!isWorkspace(target.path)) throw failure('NOT_A_WORKSPACE', `no spore called "${name}"`)
    return target.path
  }

  const servedOf = (caller, ws, id) => {
    const found = approvalOf(ws, id)
    if (!found) throw failure('API_NOT_FOUND', `no approval ${id} in this spore`)
    const kind = kindOfPlace(found)
    if (!caller.serves.includes(kind)) throw failure('APPROVAL_NOT_SERVED', `approval ${id} was asked in ${found.place}, which "${caller.name}" does not serve`, `serves on a caller in api.json lists the kinds of place it shows and answers approvals for, as ["${kind}"]`)
    if (found.hook) throw hooked(found.place, found.hook, caller.name)
    return ended(ws, found)
  }

  const hooked = (place, hook, server) => failure('APPROVAL_HOOKED', `an approval asked in ${place} names the hook ${JSON.stringify(hook)}, which nothing calls there`, `"${server}" serves that place and reports how the approval ended itself, with settled — ask it without a hook`)

  const notIn = (approval, wanted, step) => failure('APPROVAL_STATE', `approval ${approval.id} is ${approval.state}, and only one ${wanted} is ${step}`, approval.reason ?? undefined)

  const routes = {
    'GET spores': ({ caller }) => {
      const { home } = readConfig(CONFIG_FILE)
      const reached = list({ configFile: CONFIG_FILE }).workspaces
        .filter(row => row.from === home)
        .map(row => ({ name: basename(row.ws), state: row.state, turns: row.lastTurnNo }))
        .filter(row => reaches(caller, row.name))
      return { status: 200, body: { spores: reached } }
    },
    'GET spore': ({ ws }) => ({ status: 200, body: show({ ws, configFile: CONFIG_FILE }) }),
    'GET live': ({ ws, url }) => {
      const level = url.searchParams.get('level') ?? 'plain'
      if (!LEVELS.includes(level)) throw failure('API_BAD_REQUEST', `level is ${LEVELS.join(', ')} — not ${level}`)
      const running = liveIn(ws)
      if (!running) return { status: 200, body: { live: null, lines: [], seq: null } }
      return { status: 200, body: { live: running.live, lines: renderLive(running.live, { level }), seq: running.seq } }
    },
    'POST messages': async ({ request, response, ws, span }) => {
      const asked = await jsonOf(request, response)
      if (typeof asked.text !== 'string' || !asked.text.trim()) throw failure('API_BAD_REQUEST', 'a message needs its text', '{ "text": "…" }')
      const sent = send(ws, asked.text, {
        attach: attachmentsOf(asked.attach),
        requestId: asked.requestId,
        replyTo: asked.replyTo,
        from: asked.from,
        traceparent: formatTraceparent(span) ?? undefined,
        env,
        configFile: CONFIG_FILE
      })
      return { status: 202, body: { inbox: sent.inbox, started: sent.started, repeated: Boolean(sent.repeated) } }
    },
    'POST approvals': async ({ request, response, ws }) => {
      const asked = await jsonOf(request, response)
      const server = typeof asked.to === 'string' && asked.hook !== undefined ? api.callers.find(one => one.serves.includes(asked.to.slice(0, asked.to.indexOf(':')))) : null
      if (server) throw hooked(asked.to, asked.hook, server.name)
      return { status: 201, body: askApproval(ws, asked, { configFile: CONFIG_FILE }) }
    },
    'GET approvals': ({ ws, caller, url }) => {
      const open = url.searchParams.get('open')
      if (open !== null && open !== 'true') throw failure('API_BAD_REQUEST', `open is true, or left out — not ${open}`)
      if (open === null) return { status: 200, body: { approvals: approvalsIn(ws) } }
      const waiting = approvalsIn(ws, { open: true }).filter(one => caller.serves.includes(kindOfPlace(one))).map(one => ended(ws, one))
      return { status: 200, body: { approvals: waiting.filter(one => one.settledAt === null || (one.state !== 'refused' && !one.told)) } }
    },
    'GET approval': ({ ws, id }) => {
      const one = approvalOf(ws, id)
      if (!one) throw failure('API_NOT_FOUND', `no approval ${id} in this spore`)
      return { status: 200, body: one }
    },
    'POST approval posted': async ({ request, response, ws, caller, id }) => {
      const { shown, note = null } = await jsonOf(request, response)
      if (!isRecord(shown) || !(note === null || typeof note === 'string')) throw failure('API_BAD_REQUEST', 'posted says what was shown', '{ "shown": <the payload as drawn>, "note": "<your id for the message>" }, note optional')
      const approval = servedOf(caller, ws, id)
      if (!postApproval(ws, id, { shown, note })) throw notIn(approval, 'asked', 'shown')
      return { status: 200, body: { posted: true } }
    },
    'POST approval refused': async ({ request, response, ws, caller, id }) => {
      const { reason } = await jsonOf(request, response)
      if (!isText(reason)) throw failure('API_BAD_REQUEST', 'refused says why it could not be shown', '{ "reason": "…" }')
      const approval = servedOf(caller, ws, id)
      if (!refuseApproval(ws, id, reason)) throw notIn(approval, 'asked', 'refused')
      settleApproval(ws, id)
      return { status: 200, body: { refused: true } }
    },
    'POST approval answer': async ({ request, response, ws, caller, id }) => {
      const { choice, inputs = null, person } = await jsonOf(request, response)
      if (typeof choice !== 'string' || !isRecord(person) || !isText(person.id) || !isText(person.name) || !(inputs === null || isRecord(inputs))) {
        throw failure('API_BAD_REQUEST', 'an answer says who pressed what', '{ "choice": "<an option\'s id>", "person": { "id", "name" }, "inputs": { "<field id>": … } }, inputs optional — that the person is who they say is yours to have checked')
      }
      servedOf(caller, ws, id)
      return { status: 200, body: answerApproval(ws, id, { choice, inputs, person: { id: person.id, name: person.name } }) }
    },
    'POST approval settled': async ({ request, response, ws, caller, id }) => {
      const { outcome = null, reason = null, tell = null, replaced = null } = await jsonOf(request, response)
      const shape = '{ "outcome": "confirmed" or "failed", "reason": "<why it failed>", "tell": "<what the spore should know>", "replaced": <what the question was replaced with> }, each optional'
      const fits = (outcome === null || OUTCOMES.includes(outcome)) && (outcome === 'failed' ? isText(reason) : reason === null) &&
        (tell === null || isText(tell)) && (replaced === null || isRecord(replaced))
      if (!fits) throw failure('API_BAD_REQUEST', 'settled says how an ended approval was seen through', shape)
      const approval = servedOf(caller, ws, id)
      if (!['answered', 'expired'].includes(approval.state)) throw notIn(approval, 'answered or expired', 'settled')
      if (outcome !== null && approval.state === 'expired') throw failure('API_BAD_REQUEST', 'an approval nobody answered has no outcome to confirm', shape)
      const settled = settleApproval(ws, id, { outcome, reason, replaced, tell })
      const now = approvalOf(ws, id)
      const answered = now.state === 'answered'
      send(ws, endedText(now), {
        requestId: `approval:${id}`,
        replyTo: now.place,
        approval: id,
        ...(answered ? { from: { name: now.answererName, id: `${kindOfPlace(now)}:${now.answererId}`, where: now.place } } : {}),
        env,
        configFile: CONFIG_FILE
      })
      return { status: 200, body: { settled, told: true } }
    },
    'POST annotate': async ({ request, response, ws }) => ({ status: 200, body: annotateTurn(ws, (await jsonOf(request, response)).text) }),
    'POST stop': async ({ request, response, ws }) => {
      const { replyTo } = await jsonOf(request, response)
      const problem = replyTo === undefined ? null : typeof replyTo === 'string' ? native.replyToProblem(replyTo) : `got ${JSON.stringify(replyTo)}`
      if (problem) throw failure('API_BAD_REQUEST', 'replyTo is not a conversation', problem)
      return { status: 200, body: stop(ws, { replyTo }) }
    },
    'POST outcome': async ({ request, response, ws, id }) => ({ status: 200, body: takeOutcome(ws, id, await jsonOf(request, response), { env, configFile: CONFIG_FILE }) }),
    'POST wrap': async ({ request, response, ws }) => ({ status: 200, body: wrapTurn(ws, (await jsonOf(request, response)).wait) }),
    'POST extend': async ({ request, response, ws }) => {
      const { dimension, amount } = await jsonOf(request, response)
      return { status: 200, body: extendTurn(ws, dimension, String(amount)) }
    },
    'POST flush': async ({ request, response, ws }) => {
      const { entryNo, by, open } = flush({ ws, by: (await jsonOf(request, response)).by, configFile: CONFIG_FILE })
      return { status: 200, body: { entryNo, by, open } }
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
    const outcome = OUTCOME.exec(url.pathname)
    const found = ROUTE.exec(url.pathname)
    const [, name, action, id, step] = outcome ? [outcome[0], outcome[1], 'outcome', outcome[2]] : found ?? []
    const route = outcome ? 'outcome' : !found || (id && action !== 'approvals') ? null : !name ? 'spores' : step ? `approval ${step}` : id ? 'approval' : action ?? 'spore'
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
      const { status, body } = await handle({ request, response, caller, ws, id, span, url })
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
      answer(response, status, { error: { type: err.type ?? 'API_FAILED', message: err.message, ...(err.detail ? { detail: err.detail } : {}) } }, traceparent)
    }
  })
  return Object.assign(server, { routed: () => Promise.all([...routing]) })
}
