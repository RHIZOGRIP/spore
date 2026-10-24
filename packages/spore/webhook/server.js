import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

import { CONFIG_FILE, errorText, loadEnvironment, paused } from '../src/index.js'
import { createHookDelivery } from './deliveries.js'
import { acceptRefusal, hooksPath, loadHooks } from './hooks.js'
import { verify } from './verify.js'
import { readBody } from '../src/infra/http.js'

const ROUTE = /^\/hook\/([^/]+)(?:\/([^/]+))?\/?$/
const SECRET_HEADER = /authorization|cookie|token|signature|secret/i

const PAYLOAD_NAMES = [
  [/json/, 'payload.json'],
  [/x-www-form-urlencoded/, 'payload.txt'],
  [/xml/, 'payload.xml'],
  [/^text\//, 'payload.txt']
]

const payloadName = (mime) => PAYLOAD_NAMES.find(([pattern]) => pattern.test(mime))?.[1] ?? 'payload.bin'

export function keptHeaders (headers, check) {
  return Object.fromEntries(Object.entries(headers)
    .filter(([name]) => name !== check.header && !SECRET_HEADER.test(name)))
}

/**
 * `env` is the environment the service was started with: `environment` beside `config.json` is
 * read again for every request, so a secret added there takes effect without a restart.
 */
export function createWebhookServer ({ env, log, configFile = CONFIG_FILE, pausedNow = paused, ...delivering }) {
  const hooksDelivery = createHookDelivery({ log, configFile, ...delivering })
  const now = delivering.now ?? Date.now

  const freshEnv = () => {
    const fresh = { ...env }
    loadEnvironment(configFile, fresh)
    return fresh
  }

  const answer = (response, status) => {
    response.writeHead(status, { 'content-type': 'text/plain' })
    response.end(status === 202 ? 'accepted\n' : status === 503 ? 'paused\n' : '')
  }

  const handle = async (request, response) => {
    const url = new URL(request.url, 'http://webhook')
    const route = ROUTE.exec(url.pathname)
    if (!route) return answer(response, 404)
    const [, name, token] = route.map(part => part === undefined ? undefined : decodeURIComponent(part))
    const pause = pausedNow()
    if (pause) {
      log(`hook ${name} · refused — spores are paused${pause.at ? ` since ${pause.at}` : ''}`)
      return answer(response, 503)
    }
    const fresh = freshEnv()
    const hooks = loadHooks(hooksPath(configFile), fresh)
    const hook = hooks.get(name)
    if (!hook) {
      log(`hook ${name} · refused — no such hook; ${hooks.size ? `the hooks are ${[...hooks.keys()].join(', ')}` : 'hooks.json names none'}`)
      return answer(response, 404)
    }
    if (token !== undefined && hook.check.method !== 'path') {
      log(`hook ${name} · refused — a token in the path, and the hook checks its sender another way`)
      return answer(response, 404)
    }
    if (request.method !== 'POST') return answer(response, 405)

    const body = await readBody(request, response, hook.maxBytes)
    if (body === null) {
      log(`hook ${name} · refused — the body passes ${hook.maxBytes} bytes`)
      return answer(response, 413)
    }

    const refused = verify(hook.check, { headers: request.headers, body, token, now: now() })
    if (refused) {
      log(`hook ${name} · refused — ${refused}`)
      return answer(response, 401)
    }

    const event = hook.check.event ? request.headers[hook.check.event] ?? null : null
    const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`
    const delivery = (hook.check.delivery && request.headers[hook.check.delivery]) || digest
    const unmatched = hook.accept ? acceptRefusal(hook.accept, request.headers, body) : null
    if (unmatched) {
      log(`hook ${name} · ${delivery} · ignored — ${unmatched}`)
      return answer(response, 202)
    }

    const mime = (request.headers['content-type'] ?? 'application/octet-stream').split(';')[0].trim()
    const attach = [
      ...(body.length ? [{ name: payloadName(mime), mime, data: body }] : []),
      { name: 'headers.json', mime: 'application/json', data: Buffer.from(JSON.stringify(keptHeaders(request.headers, hook.check), null, 2) + '\n') }
    ]
    // Keyed on the body rather than the sender's delivery header, which no signature covers: a
    // captured request sent again under a new delivery id is still the same message.
    const options = { attach, hook: { name, event, delivery }, requestId: `webhook:${name}:${digest}` }
    const outcomes = hooksDelivery.deliverAll({
      hook,
      options,
      stdin: body.length ? payloadName(mime) : null,
      unwanted: (accept) => acceptRefusal(accept, request.headers, body),
      env
    })
    return answer(response, outcomes.some(one => one.failed) ? 500 : 202)
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(err => {
      log(`${request.method} ${request.url} · failed — ${err.type ?? err.name} ${errorText(err)}`)
      if (!response.headersSent) answer(response, 500)
    })
  })
  return Object.assign(server, { routed: hooksDelivery.routed })
}
