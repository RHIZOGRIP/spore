import { closeSync, fstatSync, openSync, readFileSync, statSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { systemReadPaths } from '../isolation/sandbox.js'

export const CONFINE_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'build', 'Release', 'confine')

/**
 * Whether `confine --contain` gets namespaces of its own on this host, so a turn sees only the
 * processes it starts: `{ contained: true }`, or `{ contained: false, why }` from the step that
 * was refused.
 */
export function containCheck () {
  const ran = spawnSync(CONFINE_BIN, ['--contain-check'], { encoding: 'utf8' })
  if (ran.error) throw ran.error
  return ran.status === 0 ? { contained: true, why: null } : { contained: false, why: ran.stdout.trim() || ran.stderr.trim() }
}

const SAMPLE_MS = 2000
// Long enough for a spawned cell's supervisor to stop its worker and record how it ended; short
// of the 5 s the runner gives the agent itself, so the agent still records its own turn.
const KILL_GRACE_MS = 2000
const GROUP_POLL_MS = 50

function cpuTicks (pid, depth = 3) {
  let total = 0
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    total += Number(fields[11]) + Number(fields[12])
  } catch { return total }
  if (depth <= 0) return total
  try {
    const kids = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim()
    for (const kid of kids ? kids.split(/\s+/) : []) total += cpuTicks(Number(kid), depth - 1)
  } catch {}
  return total
}

function sizeOf (file) {
  try { return (typeof file === 'number' ? fstatSync(file) : statSync(file)).size } catch { return 0 }
}

/**
 * One shell command, its streams on files — paths, or descriptors its caller keeps — run to its end. It is killed at `timeoutMs`, or once
 * neither its output nor its CPU time has grown for `idleMs`, and under `confine` it runs through
 * the `confine` binary: Landlock, then exec.
 *
 * @returns {Promise<{ exit: number|null, signal: string|null, killed: 'deadline'|'idle'|null, spawnError: string|null, lastProgressAt: number }>}
 */
export async function runShell ({ command, cwd, inAbs, outAbs, errAbs, confine, env, timeoutMs, idleMs, signal: sig }) {
  const inFd = inAbs ? openSync(inAbs, 'r') : 'ignore'
  const outFd = typeof outAbs === 'number' ? outAbs : openSync(outAbs, 'w')
  const errFd = typeof errAbs === 'number' ? errAbs : openSync(errAbs, 'w')

  const [bin, args] = confine
    ? [CONFINE_BIN, [...(confine.contain ? ['--contain'] : []), ...(confine.scopeSignals ? ['--scope-signals'] : []), '--write-root', confine.writeRoot, '--write', '/dev/null', ...(confine.writes ?? []).flatMap(p => ['--write', p]), ...systemReadPaths().flatMap(p => ['--read', p]), ...confine.reads.flatMap(p => ['--read', p]), '--', 'sh', '-c', command]]
    : ['sh', ['-c', command]]

  let exit = null
  let signalName = null
  let spawnError = null
  let killed = null
  const startedAt = Date.now()
  let lastProgressAt = startedAt

  // detached makes the child a group leader, so a kill reaches the whole
  // pipeline rather than just the shell that forked it.
  const child = spawn(bin, args, {
    cwd,
    stdio: [inFd, outFd, errFd],
    env,
    detached: true
  })
  // SIGTERM first: a spawned cell has a broker socket to unlink and a call
  // record to finish, and SIGKILL gives it no chance to do either. SIGKILL
  // follows for anything that ignores the ask.
  const signalGroup = (s) => { try { process.kill(-child.pid, s) } catch { child.kill(s) } }
  const groupAlive = () => {
    try {
      process.kill(-child.pid, 0)
      return true
    } catch (e) {
      return e.code !== 'ESRCH'
    }
  }
  // The shell dying on SIGTERM is exactly when escalation still matters: a
  // descendant that ignores the signal outlives it, and the group persists while
  // any member does. So the call does not finish until the escalation has run —
  // unreferencing the timer left it to be discarded at process exit, which is
  // precisely what a cancelled turn does next.
  let escalation = null
  const killGroup = () => {
    if (escalation) return
    signalGroup('SIGTERM')
    const deadline = Date.now() + KILL_GRACE_MS
    escalation = new Promise((resolve) => {
      const waiting = setInterval(() => {
        if (groupAlive() && Date.now() < deadline) return
        clearInterval(waiting)
        if (groupAlive()) signalGroup('SIGKILL')
        resolve()
      }, GROUP_POLL_MS)
    })
  }

  let seen = { bytes: 0, cpu: 0 }
  const sampler = setInterval(() => {
    const now = Date.now()
    const bytes = sizeOf(outAbs) + sizeOf(errAbs)
    const cpu = cpuTicks(child.pid)
    if (bytes > seen.bytes || cpu > seen.cpu) {
      seen = { bytes, cpu }
      lastProgressAt = now
    }
    if (now - startedAt >= timeoutMs) killed = 'deadline'
    else if (now - lastProgressAt >= idleMs) killed = 'idle'
    if (killed) killGroup()
  }, SAMPLE_MS)

  const onAbort = () => killGroup()
  sig?.addEventListener('abort', onAbort, { once: true })
  if (sig?.aborted) killGroup()
  try {
    const [code, childSignal] = await once(child, 'close')
    exit = code
    signalName = childSignal || null
  } catch (e) {
    spawnError = e.message
  } finally {
    clearInterval(sampler)
    sig?.removeEventListener('abort', onAbort)
    // Awaited, so nothing above can exit while a descendant we signalled is still
    // alive on borrowed time.
    if (escalation) await escalation
    if (outFd !== outAbs) closeSync(outFd)
    if (errFd !== errAbs) closeSync(errFd)
    if (typeof inFd === 'number') closeSync(inFd)
  }

  return { exit, signal: signalName, killed, spawnError, lastProgressAt }
}
