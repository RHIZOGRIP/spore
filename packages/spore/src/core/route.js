/**
 * A delivery nobody typed — a webhook's, a job's — held and judged before it reaches its spore: the
 * spore's router for its origin, then its triage cell, decide how long it may wait, never past the
 * owner's `maxWait`, never dropping it. Held first, until the router's timeout, so a router that
 * hangs, a cell that fails or a host that dies still lets it go then. Contract: ARCHITECTURE.md,
 * "Deliveries nobody typed".
 */

import { join } from 'node:path'

import { SporeError } from '../observability/errors.js'
import { launchStandalone } from './cell.js'
import { release as releaseHeld } from './send.js'
import { holdDelivery, originOfOptions, rescheduleHeld } from './spore-dir.js'
import { ROUTE_TIMEOUT_MS, routerFor, runRouter } from './router.js'
import { precursorFor, triage, triageIn } from './triage.js'

const iso = (ms) => new Date(ms).toISOString()

const KEPT_HELD = {
  ADMISSION_FULL: 'held — every turn slot is taken, the pass releases it once one frees',
  PAUSED: 'held — spores are paused, the pass releases it after spore unpause',
  SPEND_LIMIT: 'held — the spend limit is reached, the pass releases it once the day or month turns or the limit is raised'
}

/** Releases what is due in `ws` and says what came of it; every slot taken, or a pause, leaves it held. */
function releaseNow (release, ws, options) {
  try {
    const released = release(ws, options)
    return { outcome: released.started ? 'started' : released.released.length ? 'said to the turn running' : 'held', started: released.started }
  } catch (err) {
    if (!KEPT_HELD[err.type]) throw err
    return { outcome: KEPT_HELD[err.type], started: false }
  }
}

/** What judges deliveries from `origin` in `ws`: its router and its triage precursor, either absent. */
export function judgesOf (ws, origin) {
  return { router: routerFor(ws, origin), precursor: triageIn(ws, origin) }
}

/**
 * Says `said` with `options` (as `holdDelivery` takes them) to the spore at `ws`, from the origin
 * they name (`hook:forge`, `job:scan`) —
 * the one way a message nobody typed arrives. It is held first. When the owner bounds how long
 * that origin may wait (`maxWait`) and the spore keeps a router or a triage cell for it, they
 * judge how long in the background; otherwise it is released now, starting a turn or joining the
 * one running, and no free slot, or a pause, leaves it held for the pass. `briefing({ payload,
 * headers })` is what a triage cell is told; `envOf()` the environment a cell and a release start
 * with. Answers `{ outcome, judged, started }`: a line for the caller's log, the judgment under
 * way, and whether a turn started now.
 */
export function deliver ({ ws, said, options, maxWait = null, envOf, now = Date.now, release = releaseHeld, ...judging }) {
  const origin = originOfOptions(options)
  if (origin === null) throw new SporeError('a message a person typed is said, never delivered', { type: 'DELIVERY_INVALID', detail: 'deliver takes a webhook\'s or a job\'s message; send takes a person\'s' })
  const judges = maxWait ? judgesOf(ws, origin) : {}
  if (judges.router || judges.precursor) {
    return { ...holdAndJudge({ ws, origin, said, options, maxWait, judges, envOf, now, release, ...judging }), started: false }
  }
  const at = iso(now())
  const kept = holdDelivery(ws, said, { ...options, releaseAt: at, deadline: at })
  if (kept.repeated) return { outcome: `already ${kept.repeated === true ? 'received' : kept.repeated}`, judged: Promise.resolve(), started: false }
  return { ...releaseNow(release, ws, { env: envOf(), now: now() }), judged: Promise.resolve() }
}

function holdAndJudge ({ ws, origin, said, options, event, ref, maxWait, judges: { router, precursor }, perDay, briefing, envOf, log, heading, now, release, route = runRouter, launch = launchStandalone, routeTimeoutMs = ROUTE_TIMEOUT_MS }) {
  const arrived = now()
  const kept = holdDelivery(ws, said, { ...options, releaseAt: iso(arrived + routeTimeoutMs), deadline: iso(arrived + maxWait) })
  if (kept.repeated) return { outcome: `already ${kept.repeated === true ? 'received' : kept.repeated}`, judged: Promise.resolve() }
  const payload = kept.files.find(file => file.name !== 'headers.json')
  const headers = kept.files.find(file => file.name === 'headers.json')
  const judged = (async () => {
    let answer = { ask: true }
    if (router) {
      const routed = await route({ router, ws, payload: payload ? join(ws, payload.path) : null, headers: headers?.path ?? null, origin, event, ref, timeoutMs: routeTimeoutMs })
      answer = routed.failed ? { failed: `the router ${routed.failed}` } : routed
    }
    if (answer.ask) {
      answer = precursor
        ? await triage({
          ws,
          origin,
          ref,
          files: { ...(payload ? { [payload.name]: join(ws, payload.path) } : {}), ...(headers ? { 'headers.json': join(ws, headers.path) } : {}) },
          briefing: briefing({ payload: payload?.name ?? null, headers: Boolean(headers) }),
          perDay,
          env: envOf(),
          started: (wallMs) => rescheduleHeld(ws, kept.held, iso(now() + wallMs + routeTimeoutMs)),
          launch,
          now
        })
        : { failed: `the router asked for a triage cell, and there is no precursors/${precursorFor(origin)}.cmk` }
    }
    const wait = answer.failed ? 0 : Math.min(answer.wait, maxWait)
    rescheduleHeld(ws, kept.held, iso(arrived + wait), { urgent: wait === 0, summary: answer.summary ?? null, replaces: answer.replaces === true })
    log(`${heading} · ${answer.failed ? `${answer.failed}; delivered now` : wait === 0 ? 'routed now' : `routed to wait ${Math.round(wait / 60000)}m`}${answer.replaces ? ', replacing what was held' : ''}${answer.summary ? ` — ${answer.summary}` : ''}`)
    if (wait === 0) log(`${heading} · ${releaseNow(release, ws, { env: envOf() }).outcome}`)
  })().catch(err => log(`${heading} · routing failed — ${err.type ?? err.name} ${err.message}${err.detail ? ` — ${err.detail}` : ''}; it is released at its timeout`))
  return { outcome: `held for ${router ? router.split('/').pop() : `precursors/${precursorFor(origin)}.cmk`}`, judged }
}
