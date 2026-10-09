/**
 * A spore's router for one origin — `hook:forge`, later `job:scan` — at `data/routes/<origin>.route`
 * in its workspace (`hook-forge.route`): a program the spore wrote or its owner put there, asked how
 * long a delivery nobody typed may wait. Contract: ARCHITECTURE.md, "Deliveries nobody typed".
 *
 * It reads a payload whoever triggered the event wrote, so it runs confined — the workspace
 * readable, nothing writable but a scratch directory, an environment holding none of the
 * service's secrets — and its answer can only delay, by no more than the hook's `maxWait`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runShell } from './command.js'
import { slugOf } from './cell.js'
import { durationMs } from '../delegation/definition.js'
import { containing, readConfig } from '../library/config.js'

export const ROUTE_TIMEOUT_MS = 10_000
const SUMMARY_CHARS = 300

export function routerFor (ws, origin) {
  for (const name of [`${slugOf(origin)}.route`, `${slugOf(origin)}.route.js`]) {
    const path = join(ws, 'data', 'routes', name)
    if (existsSync(path)) return path
  }
  return null
}

const quote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`

export function answerOf (printed) {
  let answer
  try {
    answer = JSON.parse(printed.trim())
  } catch {
    return { failed: 'printed something that is not one JSON object' }
  }
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return { failed: 'printed something that is not one JSON object' }
  if (answer.ask === true) return { ask: true }
  const wait = answer.wait === 0 || answer.wait === '0' ? 0 : durationMs(String(answer.wait))
  if (wait === null || !(wait >= 0)) return { failed: `answered a wait of ${JSON.stringify(answer.wait)}, which is neither "0" nor a duration as 30m` }
  const summary = typeof answer.summary === 'string' && answer.summary.trim()
    ? answer.summary.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_CHARS)
    : null
  return { wait, summary, replaces: answer.replaces === true }
}

/**
 * `{ wait, summary, replaces }` — `wait` in milliseconds, `replaces` dropping any delivery still
 * held from the same origin — `{ ask: true }` when it leaves the delivery to the
 * spore's triage cell, or `{ failed }` saying why there is no answer:
 * it could not start, ran past `timeoutMs`, exited non-zero, or printed something else.
 */
export async function runRouter ({ router, ws, payload, headers, origin, event, ref, timeoutMs = ROUTE_TIMEOUT_MS, contain = containing(readConfig()) }) {
  const scratch = mkdtempSync(join(tmpdir(), 'spore-route-'))
  try {
    const program = router.endsWith('.js') ? `${quote(process.execPath)} ${quote(router)}` : quote(router)
    const outAbs = join(scratch, 'out')
    const errAbs = join(scratch, 'err')
    const ran = await runShell({
      command: [program, quote(origin), quote(event ?? ''), quote(ref), quote(headers ?? '')].join(' '),
      cwd: ws,
      inAbs: payload,
      outAbs,
      errAbs,
      confine: { writeRoot: scratch, reads: [ws], scopeSignals: true, contain },
      env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch },
      timeoutMs,
      idleMs: timeoutMs
    })
    if (ran.spawnError) return { failed: `could not start — ${ran.spawnError}` }
    if (ran.killed) return { failed: `was stopped after ${timeoutMs / 1000} s` }
    if (ran.exit !== 0) {
      const said = readFileSync(errAbs, 'utf8').trim().split('\n').at(-1)
      return { failed: `exited ${ran.exit ?? ran.signal}${said ? ` — ${said}` : ''}` }
    }
    return answerOf(readFileSync(outAbs, 'utf8'))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
