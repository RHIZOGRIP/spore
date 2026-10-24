/**
 * A spore's router for one origin — `hook:forge`, `job:scan`, `api:pipeline` — at
 * `data/routes/<origin>.route` in its workspace (`hook-forge.route`): a program the spore wrote or its
 * owner put there, asked how long a delivery nobody typed may wait. Contract: ARCHITECTURE.md,
 * "Deliveries nobody typed".
 *
 * It reads a payload whoever triggered the event wrote, so it runs confined — the workspace
 * readable, nothing writable but a scratch directory, an environment holding none of the
 * service's secrets — and its answer can only delay, by no more than its origin's `maxWait`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runShell } from './command.js'
import { slugOf } from './cell.js'
import { containOf } from './plugins.js'
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
 * spore's triage cell, or `{ failed }` saying why there is no answer, as `runStep` does, or that it
 * printed something else. Its arguments are the origin, the event, `ref`, and `headers` and
 * `prepared` — where the headers are and what the prepare step attached, relative to `ws` — each
 * empty when absent. It runs in `ws`, which it reads.
 */
export async function runRouter ({ router, ws, payload, headers, prepared = null, origin, event, ref, timeoutMs = ROUTE_TIMEOUT_MS, contain = containing(readConfig()) }) {
  const program = router.endsWith('.js') ? [process.execPath, router] : [router]
  return runStep({
    argv: [...program, origin, event ?? '', ref, headers ?? '', prepared ?? ''],
    ws,
    cwd: ws,
    payload,
    reads: [ws],
    timeoutMs,
    contain,
    answer: ({ printed }) => answerOf(printed)
  })
}

/**
 * Runs `argv` on a delivery to the spore at `ws`, as every step on a delivery nobody typed runs:
 * confined, the payload on its stdin, `reads` readable, nothing writable but a scratch directory —
 * its working directory unless `cwd` is given — holding `out/`, an environment holding none of the
 * service's secrets. Answers what `answer({ printed, out })` makes of what it printed and of
 * `out/`, or `{ failed }`: it could not start, ran past `timeoutMs` or exited non-zero.
 */
export async function runStep ({ argv, ws, cwd = null, payload, reads, timeoutMs, contain, answer }) {
  let keep
  try {
    keep = containOf(ws)
  } catch (err) {
    return { failed: `could not start — ${err.message}` }
  }
  const scratch = mkdtempSync(join(tmpdir(), 'spore-step-'))
  try {
    const out = join(scratch, 'out')
    mkdirSync(out)
    const printedAbs = join(scratch, 'printed')
    const errAbs = join(scratch, 'err')
    const ran = await runShell({
      command: argv.map(quote).join(' '),
      cwd: cwd ?? scratch,
      inAbs: payload,
      outAbs: printedAbs,
      errAbs,
      confine: { writeRoot: scratch, reads, scopeSignals: true, contain, keep },
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
    return answer({ printed: readFileSync(printedAbs, 'utf8'), out })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
