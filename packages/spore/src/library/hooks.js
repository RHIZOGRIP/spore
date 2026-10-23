/**
 * The hooks in `hooks.json` as the webhook service reads them, and what each has said to its
 * spores: the deliveries in their inboxes, the ones still held, the triage cells they started.
 * A request the service refused never reached a spore, so it is in the service's journal only.
 */

import { CONFIG_FILE, readConfig, workspaceFor } from './config.js'
import { isWorkspace } from './discover.js'
import { cellsOf, heldIn, hookDeliveries } from '../core/spore-dir.js'
import { routerFor } from '../core/router.js'
import { triageIn } from '../core/triage.js'
import { SporeError } from '../observability/errors.js'
import { hooksPath, loadHooks } from '../../webhook/hooks.js'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

const acceptOf = (accept) => accept && {
  ...(accept.header ? { header: accept.header, values: accept.values } : {}),
  payload: Boolean(accept.payload)
}

function summary (hook, config, { since, limit }) {
  const origin = `hook:${hook.name}`
  return {
    name: hook.name,
    path: `/hook/${hook.name}`,
    verify: { method: hook.check.method, header: hook.check.header ?? null },
    accept: acceptOf(hook.accept),
    maxBytes: hook.maxBytes,
    perHour: hook.perHour,
    maxWait: hook.maxWait,
    perDay: hook.perDay,
    owner: hook.router && { plugin: hook.router.plugin, name: hook.router.name, timeoutMs: hook.router.timeoutMs, attach: hook.router.attach, reads: hook.router.reads },
    spores: hook.spores.map(name => {
      const ws = workspaceFor(name, { config }).path
      if (!isWorkspace(ws)) return { name, ws: null }
      return {
        name,
        ws,
        accept: acceptOf(hook.accepts.get(name)),
        router: routerFor(ws, origin),
        triage: triageIn(ws, origin),
        ...hookDeliveries(ws, hook.name, { since, limit }),
        held: heldIn(ws).filter(held => held.origin === origin).map(({ at, releaseAt, deadline, summary }) => ({ at, releaseAt, deadline, summary })),
        cells: cellsOf(ws, origin, { limit })
      }
    })
  }
}

export function listHooks ({ configFile = CONFIG_FILE, env = process.env, now = Date.now } = {}) {
  const file = hooksPath(configFile)
  const config = readConfig(configFile)
  const since = new Date(now() - WEEK_MS).toISOString()
  const hooks = [...loadHooks(file, env).values()].map(hook => summary(hook, config, { since, limit: 1 }))
  return { file, since, hooks }
}

export function showHook (name, { configFile = CONFIG_FILE, env = process.env, now = Date.now, last = 20 } = {}) {
  const file = hooksPath(configFile)
  const hooks = loadHooks(file, env)
  const hook = hooks.get(name)
  if (!hook) {
    throw new SporeError(`no hook called "${name}"`, {
      type: 'WEBHOOK_UNKNOWN',
      detail: hooks.size ? `${file} names ${[...hooks.keys()].join(', ')}` : `${file} names none`
    })
  }
  const since = new Date(now() - WEEK_MS).toISOString()
  return { file, since, ...summary(hook, readConfig(configFile), { since, limit: last }) }
}
