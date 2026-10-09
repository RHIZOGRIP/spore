import { describe, it, expect } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, constants, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CONFINE_BIN, containCheck, runShell } from '../src/core/command.js'

const CONTAINED = containCheck().contained
const confine = (args, options = {}) => spawnSync(CONFINE_BIN, args, { encoding: 'utf8', ...options })
const contained = (script, options) => confine(['--contain', '--no-landlock', '--', 'sh', '-c', script], options)

const carrying = (mark) => readdirSync('/proc').filter(pid => /^\d+$/.test(pid)).filter(pid => {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8').includes(mark)
  } catch {
    return false
  }
})

describe(`a command confine contains ${CONTAINED ? '' : '(skipped: this host gives no unprivileged user namespaces) '}`, () => {
  it.skipIf(!CONTAINED)('sees only the processes it started, as the user it ran as', () => {
    const outside = spawn('sleep', ['30'])
    try {
      const ran = contained(`ls /proc | grep -c '^[0-9]'; test -e /proc/${outside.pid} && echo seen; id -u`)
      expect(ran.status, ran.stderr).toBe(0)
      expect(ran.stdout).not.toMatch(/seen/)
      const [count, uid] = ran.stdout.trim().split('\n')
      expect(Number(count)).toBeLessThan(6)
      expect(Number(uid)).toBe(process.getuid())
    } finally {
      outside.kill()
    }
  })

  it.skipIf(!CONTAINED)('ends as its command ended: the same code, or the same signal', () => {
    expect(contained('exit 7').status).toBe(7)
    expect(contained('kill -TERM $$').signal).toBe('SIGTERM')
  })

  it.skipIf(!CONTAINED)('passes a signal it is sent on to the command', async () => {
    const child = spawn(CONFINE_BIN, ['--contain', '--no-landlock', '--', 'sh', '-c', 'trap "exit 42" TERM; sleep 30 & wait'])
    await new Promise(resolve => setTimeout(resolve, 300))
    child.kill('SIGTERM')
    const [code] = await once(child, 'exit')
    expect(code).toBe(42)
  })

  it.skipIf(!CONTAINED)('leaves nothing running once it is killed', async () => {
    const mark = `SPORE_CONTAIN_TEST=${process.pid}-${Date.now()}`
    const [name, value] = mark.split('=')
    const child = spawn(CONFINE_BIN, ['--contain', '--no-landlock', '--', 'sh', '-c', 'sleep 300 & sleep 300 & wait'], { env: { ...process.env, [name]: value } })
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(carrying(mark).length).toBeGreaterThan(2)
    child.kill('SIGKILL')
    await once(child, 'exit')
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(carrying(mark)).toEqual([])
  })

  it.skipIf(!CONTAINED)('contains a job\'s command, writing the directory the job pinned and reading its own /proc', async () => {
    const outside = spawn('sleep', ['30'])
    const island = mkdtempSync(join(tmpdir(), 'spore-contain-'))
    const pinned = openSync(island, constants.O_RDONLY | constants.O_DIRECTORY)
    try {
      const ran = await runShell({
        command: `test ! -e /proc/${outside.pid} && ls /proc | grep -q '^1$' && echo written > ${island}/result`,
        cwd: island,
        outAbs: 1,
        errAbs: 2,
        confine: { writeRoot: `/proc/${process.pid}/fd/${pinned}`, reads: [], scopeSignals: true, contain: true },
        env: process.env
      })
      expect(ran.exit).toBe(0)
      expect(readFileSync(join(island, 'result'), 'utf8')).toBe('written\n')
    } finally {
      outside.kill()
      closeSync(pinned)
      rmSync(island, { recursive: true, force: true })
    }
  })

  it.skipIf(CONTAINED)('runs nothing on a host that cannot contain it, and says which step it refused', () => {
    const ran = confine(['--contain', '--no-landlock', '--', 'sh', '-c', 'echo ran'])
    expect(ran.status).toBe(126)
    expect(ran.stdout).toBe('')
    expect(ran.stderr).toMatch(/^confine: this host cannot contain the command, so it was not run: cannot /)
  })

  it('says whether this host can contain, and why not', () => {
    const checked = confine(['--contain-check'])
    expect(checked.status).toBe(CONTAINED ? 0 : 1)
    expect(checked.stdout.trim()).toMatch(CONTAINED ? /^contained$/ : /^cannot /)
  })
})

describe('a confined command run as root', () => {
  it.skipIf(!CONTAINED)('is refused, even root of a user namespace only', () => {
    const ran = spawnSync('unshare', ['-r', CONFINE_BIN, '--no-landlock', '--', 'sh', '-c', 'echo ran'], { encoding: 'utf8' })
    expect(ran.status).toBe(126)
    expect(ran.stdout).toBe('')
    expect(ran.stderr).toMatch(/refuses to run anything as root/)
  })
})

describe('what a confined command may not call', () => {
  it('cannot make namespaces, contained or not', () => {
    for (const args of [['--contain', '--no-landlock'], ['--no-landlock']]) {
      const ran = confine([...args, '--', 'unshare', '-U', 'true'])
      expect(ran.status, ran.stderr).not.toBe(0)
      expect(ran.stderr).toMatch(/Operation not permitted/)
    }
  })

  it('still starts threads and processes', () => {
    const ran = confine(['--no-landlock', '--', process.execPath, '-e', 'require("node:child_process").execFileSync("true"); new (require("node:worker_threads").Worker)("", { eval: true })'])
    expect(ran.status, ran.stderr).toBe(0)
  })

  it('refuses a command that names no Landlock and no write root', () => {
    const ran = confine(['--', 'true'])
    expect(ran.status).toBe(126)
    expect(ran.stderr).toMatch(/--no-landlock/)
  })
})
