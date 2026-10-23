/**
 * A delivery nobody typed — a webhook's, a job's, a program's through the API — held and judged before it reaches its spore: the
 * spore's router for its origin, then its triage cell, decide how long it may wait, never past the
 * owner's `maxWait`, never dropping it — or, where the owner binds a router to the origin, that
 * router attaches to it and nothing delays it. Held first, until the router's timeout, so a router
 * that hangs, a cell that fails or a host that dies still lets it go then. Contract:
 * ARCHITECTURE.md, "Deliveries nobody typed".
 */

import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { SporeError } from '../observability/errors.js'
import { launchStandalone } from './cell.js'
import { release as releaseHeld } from './send.js'
import { ownerRouter } from './plugins.js'
import { INBOX_DIR, attachHeld, holdDelivery, originOfOptions, releaseHeld as releaseDue, rescheduleHeld } from './spore-dir.js'
import { ROUTE_TIMEOUT_MS, readsOf, routerFor, runOwnerRouter, runRouter } from './router.js'
import { precursorFor, triage, triageIn } from './triage.js'

const iso = (ms) => new Date(ms).toISOString()
const OWNER_GRACE_MS = 5_000

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
 * they name (`hook:forge`, `job:scan`, `api:engine`) —
 * the one way a message nobody typed arrives. It is held first. When the owner bounds how long
 * that origin may wait (`maxWait`) and the spore keeps a router or a triage cell for it, they
 * judge how long in the background; otherwise it is released now, starting a turn or joining the
 * one running, and no free slot, or a pause, leaves it held for the pass. `briefing({ payload,
 * headers })` is what a triage cell is told; `envOf()` the environment a cell and a release start
 * with; `stdin` and `headers` the names of the attached files the owner's router is given as the
 * payload and the headers, either null. Answers `{ outcome, judged, started }`: a line for the caller's log, the judgment under
 * way, and whether a turn started now.
 */
export function deliver ({ ws, said, options, maxWait = null, owner = null, envOf, now = Date.now, release = releaseHeld, ...judging }) {
  const origin = originOfOptions(options)
  if (origin === null) throw new SporeError('a message a person typed is said, never delivered', { type: 'DELIVERY_INVALID', detail: 'deliver takes a webhook\'s, a job\'s or an API caller\'s message; send takes a person\'s' })
  if (owner) return holdAndAttach({ ws, origin, said, options, owner, envOf, now, release, ...judging })
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

/**
 * A delivery held while the owner's router for its origin attaches to it, then released at once:
 * the spore's own router and triage cell are not asked. It is held with a line saying the router
 * did not answer, so a service that stops before it does still lets it go at the router's timeout,
 * and that line is what the turn reads; the router replaces it with what it attached, or with why
 * it attached nothing. `start: false` releases it without starting a turn.
 */
function holdAndAttach ({ ws, origin, said, options, owner, stdin = null, headers: headersName = null, event, ref, envOf, log, heading, now, release, start = true, attachBy = runOwnerRouter, routerOf = ownerRouter }) {
  const label = `what router "${owner.name}" attaches`
  const untold = { path: null, name: label, mime: null, bytes: null, missing: 'it did not answer: what ran it stopped first' }
  const until = iso(now() + owner.timeoutMs + OWNER_GRACE_MS)
  const kept = holdDelivery(ws, said, { ...options, attach: [...(options.attach ?? []), untold], releaseAt: until, deadline: until })
  if (kept.repeated) return { outcome: `already ${kept.repeated === true ? 'received' : kept.repeated}`, judged: Promise.resolve(), started: false }
  const files = kept.files.slice(0, -1)
  const payload = stdin === null ? null : files.find(file => file.path && file.name === stdin)
  const headers = headersName === null ? null : files.find(file => file.path && file.name === headersName)
  const delivery = files.find(file => file.path) ? dirname(files.find(file => file.path).path) : `${INBOX_DIR}/${iso(now()).replace(/[-:.]/g, '')}-${randomBytes(3).toString('hex')}`
  const into = `${delivery}/${owner.name}`
  const judged = (async () => {
    let attached
    try {
      const { program, reads } = routerOf(owner.plugin, owner.name)
      attached = await attachBy({
        program,
        programReads: reads,
        ws,
        delivery: files.length ? join(ws, delivery) : null,
        payload: payload ? join(ws, payload.path) : null,
        headers: headers ? join(ws, headers.path) : null,
        origin,
        event,
        ref,
        into,
        timeoutMs: owner.timeoutMs,
        attach: owner.attach,
        reads: readsOf(ws, owner.reads)
      })
    } catch (err) {
      attached = { failed: `could not start — ${err.message}${err.detail ? ` — ${err.detail}` : ''}` }
    }
    const told = attached.failed ? [{ ...untold, missing: `the router ${attached.failed}` }] : attached.files
    if (!attachHeld(ws, kept.held, [...files, ...told])) {
      rmSync(join(ws, into), { recursive: true, force: true })
      return log(`${heading} · router ${owner.plugin}/${owner.name} answered after the delivery was released without it`)
    }
    rescheduleHeld(ws, kept.held, iso(now()), { urgent: true })
    log(`${heading} · ${attached.failed ? `router ${owner.plugin}/${owner.name} ${attached.failed}; delivered without its attachments` : `router ${owner.plugin}/${owner.name} attached ${attached.files.length} file${attached.files.length === 1 ? '' : 's'}`}`)
    if (!start) {
      releaseDue(ws, iso(now()), { due: true })
      return log(`${heading} · said, not started`)
    }
    log(`${heading} · ${releaseNow(release, ws, { env: envOf() }).outcome}`)
  })().catch(err => log(`${heading} · attaching failed — ${err.type ?? err.name} ${err.message}${err.detail ? ` — ${err.detail}` : ''}; it is released at its timeout`))
  return { outcome: `held for router ${owner.plugin}/${owner.name}`, judged, started: false }
}
