import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

import { CONFIG_FILE, isWorkspace, loadEnvironment, paused, readConfig, release, send, workspaceFor } from '../src/index.js'
import { launchStandalone } from '../src/core/cell.js'
import { deliver } from '../src/core/route.js'
import { ROUTE_TIMEOUT_MS, runRouter } from '../src/core/router.js'
import { acceptRefusal, hooksPath, loadHooks } from './hooks.js'
import { verify } from './verify.js'

const HOUR = 60 * 60 * 1000
const ROUTE = /^\/hook\/([^/]+)(?:\/([^/]+))?\/?$/
const SECRET_HEADER = /authorization|cookie|token|signature|secret/i

const said = (err) => [err.message, err.detail].filter(Boolean).join(' — ')

// What a spore is handed of the service's environment: everything but its hooks' secrets,
// which only the service checks requests with.
const without = (env, hidden) => Object.fromEntries(Object.entries(env).filter(([key]) => !hidden.has(key)))

const PAYLOAD_NAMES = [
  [/json/, 'payload.json'],
  [/x-www-form-urlencoded/, 'payload.txt'],
  [/xml/, 'payload.xml'],
  [/^text\//, 'payload.txt']
]

const payloadName = (mime) => PAYLOAD_NAMES.find(([pattern]) => pattern.test(mime))?.[1] ?? 'payload.bin'

const briefingOf = ({ name, event, delivery }) => ({ payload, headers }) => [
  `A delivery of the webhook "${name}"${event ? `, event ${event}` : ''}, delivery ${delivery}.`,
  payload ? `Its body is ${payload} in your directory.` : 'It has no body.',
  headers ? 'Its headers, without any that carry a secret, are headers.json.' : ''
].filter(Boolean).join('\n') + '\n'

function readBody (request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    request.on('data', chunk => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        request.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

export function keptHeaders (headers, check) {
  return Object.fromEntries(Object.entries(headers)
    .filter(([name]) => name !== check.header && !SECRET_HEADER.test(name)))
}

/**
 * `env` is the environment the service was started with: `environment` beside `config.json` is
 * read again for every request, so a secret added there takes effect without a restart.
 */
export function createWebhookServer ({
  env,
  log,
  configFile = CONFIG_FILE,
  say = (ws, text, options) => send(ws, text, { ...options, start: false }),
  sporeOf = (name) => {
    const ws = workspaceFor(name, { config: readConfig(configFile) }).path
    return isWorkspace(ws) ? ws : null
  },
  now = Date.now,
  route = runRouter,
  launchCell = launchStandalone,
  routeTimeoutMs = ROUTE_TIMEOUT_MS,
  releaseHeld = release,
  pausedNow = paused
}) {
  const started = new Map()
  const routing = new Set()

  const freshEnv = () => {
    const fresh = { ...env }
    loadEnvironment(configFile, fresh)
    return fresh
  }

  const underLimit = (hook, spore) => {
    const key = `${hook.name}\0${spore}`
    const recent = (started.get(key) ?? []).filter(at => now() - at < HOUR)
    started.set(key, recent)
    return recent.length < hook.perHour
  }
  const counted = (hook, spore) => started.get(`${hook.name}\0${spore}`).push(now())

  const deliverTo = (hook, spore, ws, text, options, heading, hidden) => {
    if (!underLimit(hook, spore)) {
      say(ws, text, options)
      return `said, not started — ${hook.perHour} turns started in the last hour`
    }
    const { event, delivery } = options.hook
    const delivered = deliver({
      ws,
      said: text,
      options,
      event,
      ref: delivery,
      maxWait: hook.maxWait ?? null,
      perDay: hook.perDay,
      briefing: briefingOf(options.hook),
      envOf: () => without(freshEnv(), hidden),
      log,
      heading,
      now,
      route,
      launch: launchCell,
      release: releaseHeld,
      routeTimeoutMs
    })
    if (delivered.started) counted(hook, spore)
    routing.add(delivered.judged)
    delivered.judged.finally(() => routing.delete(delivered.judged))
    return delivered.outcome
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
    const hidden = new Set([...hooks.values()].flatMap(each => each.secrets))
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

    if (Number(request.headers['content-length']) > hook.maxBytes) {
      log(`hook ${name} · refused — ${request.headers['content-length']} bytes, more than ${hook.maxBytes}`)
      return answer(response, 413)
    }
    const body = await readBody(request, hook.maxBytes)
    if (body === null) {
      log(`hook ${name} · refused — the body passed ${hook.maxBytes} bytes`)
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
    const text = ''
    // Keyed on the body rather than the sender's delivery header, which no signature covers: a
    // captured request sent again under a new delivery id is still the same message.
    const options = { attach, hook: { name, event, delivery }, requestId: `webhook:${name}:${digest}`, env: without(fresh, hidden) }
    let failed = false
    for (const spore of hook.spores) {
      const heading = `hook ${name} → ${spore} · ${delivery}${event ? ` · ${event}` : ''}`
      const own = hook.accepts.get(spore)
      const unwanted = own ? acceptRefusal(own, request.headers, body) : null
      if (unwanted) {
        log(`${heading} · ignored — ${unwanted}`)
        continue
      }
      const ws = sporeOf(spore)
      if (!ws) {
        failed = true
        log(`${heading} · not delivered — there is no spore "${spore}"`)
        continue
      }
      try {
        log(`${heading} · ${deliverTo(hook, spore, ws, text, options, heading, hidden)}`)
      } catch (err) {
        failed = true
        log(`${heading} · not delivered — ${err.type ?? err.name} ${said(err)}`)
      }
    }
    return answer(response, failed ? 500 : 202)
  }

  const server = createServer((request, response) => {
    handle(request, response).catch(err => {
      log(`${request.method} ${request.url} · failed — ${err.type ?? err.name} ${said(err)}`)
      if (!response.headersSent) answer(response, 500)
    })
  })
  return Object.assign(server, { routed: () => Promise.all([...routing]) })
}
