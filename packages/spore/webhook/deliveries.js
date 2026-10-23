/**
 * One delivery of a hook handed to each spore it names, under the hook's bounds: its `perHour`, its
 * `maxWait` for the spore's router or triage cell, or the owner's router bound to it. The webhook
 * service and the HTTP API both deliver through it, each having checked its sender its own way.
 */

import { isWorkspace, readConfig, release, send, workspaceFor } from '../src/index.js'
import { launchStandalone } from '../src/core/cell.js'
import { ownerRouter } from '../src/core/plugins.js'
import { deliver } from '../src/core/route.js'
import { ROUTE_TIMEOUT_MS, runOwnerRouter, runRouter } from '../src/core/router.js'
import { CONFIG_FILE } from '../src/library/config.js'

const HOUR = 60 * 60 * 1000

const said = (err) => [err.message, err.detail].filter(Boolean).join(' — ')

/** What a spore is handed of an environment: everything but the hooks' secrets, which only the senders' checks use. */
export const without = (env, hidden) => Object.fromEntries(Object.entries(env).filter(([key]) => !hidden.has(key)))

const briefingOf = ({ name, event, delivery }) => ({ payload, headers }) => [
  `A delivery of the webhook "${name}"${event ? `, event ${event}` : ''}, delivery ${delivery}.`,
  payload ? `Its body is ${payload} in your directory.` : 'It has no body.',
  headers ? 'Its headers, without any that carry a secret, are headers.json.' : ''
].filter(Boolean).join('\n') + '\n'

export function createHookDelivery ({
  log,
  configFile = CONFIG_FILE,
  say = (ws, text, options) => send(ws, text, { ...options, start: false }),
  sporeOf = (name) => {
    const ws = workspaceFor(name, { config: readConfig(configFile) }).path
    return isWorkspace(ws) ? ws : null
  },
  now = Date.now,
  route = runRouter,
  attachBy = runOwnerRouter,
  routerOf = ownerRouter,
  launchCell = launchStandalone,
  routeTimeoutMs = ROUTE_TIMEOUT_MS,
  releaseHeld = release
}) {
  const started = new Map()
  const routing = new Set()

  const underLimit = (hook, spore) => {
    const key = `${hook.name}\0${spore}`
    const recent = (started.get(key) ?? []).filter(at => now() - at < HOUR)
    started.set(key, recent)
    return recent.length < hook.perHour
  }
  const counted = (hook, spore) => started.get(`${hook.name}\0${spore}`).push(now())

  const deliverTo = (hook, spore, ws, options, heading, envOf) => {
    const start = underLimit(hook, spore)
    if (!start && !hook.router) {
      say(ws, '', options)
      return `said, not started — ${hook.perHour} turns started in the last hour`
    }
    const { event, delivery } = options.hook
    const delivered = deliver({
      ws,
      said: '',
      options,
      event,
      ref: delivery,
      maxWait: hook.maxWait ?? null,
      owner: hook.router,
      start,
      perDay: hook.perDay,
      briefing: briefingOf(options.hook),
      envOf,
      log,
      heading,
      now,
      route,
      launch: launchCell,
      release: releaseHeld,
      routeTimeoutMs,
      attachBy,
      routerOf
    })
    if (delivered.started || (hook.router && start)) counted(hook, spore)
    routing.add(delivered.judged)
    delivered.judged.finally(() => routing.delete(delivered.judged))
    return delivered.outcome
  }

  /**
   * `options` as `send` takes them, with `hook: { name, event, delivery }` and its `requestId`;
   * `unwanted(accept)` says why a spore's own `accept` drops it, or null; `envOf()` the environment
   * a turn or a cell starts with, the hooks' secrets already out of it. Answers each spore's
   * outcome, `failed` for one it could not reach.
   */
  const deliverAll = ({ hook, options, unwanted, envOf }) => hook.spores.map(spore => {
    const { delivery, event } = options.hook
    const heading = `hook ${hook.name} → ${spore} · ${delivery}${event ? ` · ${event}` : ''}`
    const own = hook.accepts.get(spore)
    const dropped = own ? unwanted(own) : null
    if (dropped) {
      log(`${heading} · ignored — ${dropped}`)
      return { spore, outcome: `ignored — ${dropped}` }
    }
    const ws = sporeOf(spore)
    if (!ws) {
      log(`${heading} · not delivered — there is no spore "${spore}"`)
      return { spore, outcome: `not delivered — there is no spore "${spore}"`, failed: true }
    }
    try {
      const outcome = deliverTo(hook, spore, ws, { ...options, env: envOf() }, heading, envOf)
      log(`${heading} · ${outcome}`)
      return { spore, outcome }
    } catch (err) {
      log(`${heading} · not delivered — ${err.type ?? err.name} ${said(err)}`)
      return { spore, outcome: `not delivered — ${err.type ?? err.name} ${said(err)}`, failed: true }
    }
  })

  return { deliverAll, routed: () => Promise.all([...routing]) }
}
