/**
 * What this host refuses a turn's commands, tried rather than read: each crossing is attempted
 * by a command run as a job's is — `runShell` under `confine`, contained as the host contains
 * — with no model in the loop. What varies from host to host is the kernel and its security
 * modules, so that is what it tries; what spore's own code decides is the same everywhere.
 */

import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'

import { CONFINE_BIN, containCheck, runShell } from '../core/command.js'
import { SLOT_DIR } from '../core/admission.js'
import { landlockAbi, systemReadPaths } from '../isolation/sandbox.js'
import { CONFIG_FILE, containing, readConfig } from './config.js'

const TRY_MS = 10_000

/**
 * Each crossing tried on this host: `{ boundary: [{ tried, outcome, why }], findings }`, `outcome`
 * `refused`, `crossed` or `untried`, and a problem among `findings` for each crossing this host
 * should have refused. With no Landlock, or a config.json it cannot read, it tries nothing, and
 * `doctor` says why.
 */
export async function boundary ({ configFile = CONFIG_FILE } = {}) {
  const findings = []
  const abi = landlockAbi()
  if (abi < 0) return { boundary: [], findings }
  let config
  try {
    config = readConfig(configFile)
  } catch {
    return { boundary: [], findings }
  }
  const asked = containing(config)
  const contain = asked && containCheck().contained
  const scoped = abi >= 6

  const base = join(dirname(SLOT_DIR), 'probe')
  mkdirSync(base, { recursive: true })
  const dir = mkdtempSync(join(base, 'run-'))
  try {
    const real = realpathSync(dir)
    const granted = systemReadPaths().filter(existsSync).map(path => realpathSync(path)).find(path => real === path || real.startsWith(`${path}/`))
    if (granted) return { boundary: [{ tried: 'anything', outcome: 'untried', why: `${dir} is inside ${granted}, which every confined command may read` }], findings }
    const ws = join(dir, 'ws')
    const scratch = join(dir, 'scratch')
    mkdirSync(ws)
    mkdirSync(scratch)
    writeFileSync(join(ws, 'granted'), 'granted\n')
    writeFileSync(join(dir, 'outside'), 'outside\n')

    let tries = 0
    const attempt = async (command) => {
      tries += 1
      const out = join(dir, `${tries}.out`)
      const err = join(dir, `${tries}.err`)
      const ran = await runShell({
        command,
        cwd: scratch,
        outAbs: out,
        errAbs: err,
        confine: { writeRoot: scratch, reads: [ws], scopeSignals: true, contain },
        env: { PATH: process.env.PATH, HOME: scratch },
        timeoutMs: TRY_MS,
        idleMs: TRY_MS
      })
      const said = [out, err].filter(existsSync).map(file => readFileSync(file, 'utf8').trim()).filter(Boolean).join(' — ')
      return { ...ran, said }
    }

    const control = await attempt(`cat '${join(ws, 'granted')}' && echo written > '${join(scratch, 'written')}'`)
    if (control.exit !== 0) {
      const why = control.spawnError ?? (control.said || `exited ${control.exit ?? control.signal}`)
      return { boundary: [{ tried: 'anything', outcome: 'untried', why: `a confined command could not read what it is granted and write where it may, so a refusal would prove nothing — ${why}` }], findings }
    }

    const crossings = [
      { tried: 'read a file outside what it is granted', command: `cat '${join(dir, 'outside')}'`, refuses: true },
      { tried: 'write outside the directory it writes', command: `echo crossed > '${join(dir, 'written')}'`, refuses: true, left: join(dir, 'written') },
      { tried: 'write a directory it may only read', command: `echo crossed > '${join(ws, 'written')}'`, refuses: true, left: join(ws, 'written') },
      { tried: 'see a process outside it', command: `test -e /proc/${process.pid}`, refuses: contain, otherwise: asked ? 'this host cannot contain it' : 'contain is off' },
      { tried: 'signal a process outside it', command: `kill -0 ${process.pid}`, refuses: contain || scoped, otherwise: `contain is ${asked ? 'not possible here' : 'off'}, and Landlock ${abi} cannot scope signals` },
      { tried: 'make namespaces of its own', command: `'${CONFINE_BIN}' --contain-check`, refuses: true }
    ]
    const results = await Promise.all(crossings.map(async (one) => ({ one, ran: await attempt(one.command) })))

    const shown = results.map(({ one, ran }) => {
      if (ran.spawnError) return { tried: one.tried, outcome: 'untried', why: ran.spawnError }
      const crossed = ran.exit === 0 || (one.left && existsSync(one.left))
      if (!crossed) return { tried: one.tried, outcome: 'refused', why: ran.said || `exited ${ran.exit ?? ran.signal}` }
      if (one.refuses) findings.push({ area: 'machine', subject: 'boundary', severity: 'problem', problem: `a turn's command could ${one.tried} on this host`, fix: 'run no spore here until spore doctor shows it refused, and tell us: spore doctor --report' })
      return { tried: one.tried, outcome: 'crossed', why: one.refuses ? 'it should have been refused' : one.otherwise }
    })
    return { boundary: shown, findings }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
