import { describe, it, expect } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CONFINE_BIN, containCheck, runShell } from '../src/core/command.js'
import { native } from '../src/native.js'

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

describe(`a contained command kept to one directory of another ${CONTAINED ? '' : '(skipped: this host gives no unprivileged user namespaces) '}`, () => {
  const laidOut = () => {
    const hide = mkdtempSync(join(tmpdir(), 'spore-hide-'))
    const keep = join(hide, 'spores', 'mine')
    mkdirSync(keep, { recursive: true })
    mkdirSync(join(hide, 'spores', 'theirs'))
    writeFileSync(join(hide, 'agent.sock'), '')
    writeFileSync(join(hide, 'spores', 'theirs', 'sluice.sock'), '')
    return { hide, keep }
  }

  it.skipIf(!CONTAINED)('sees what is in the one it keeps, as it changes, and nothing else of the one hidden', async () => {
    const { hide, keep } = laidOut()
    try {
      const child = spawn(CONFINE_BIN, ['--contain', '--hide', hide, '--keep', keep, '--no-landlock', '--', 'sh', '-c', `sleep 0.6; find ${hide} | sort`])
      let out = ''
      child.stdout.on('data', chunk => { out += chunk })
      await new Promise(resolve => setTimeout(resolve, 200))
      writeFileSync(join(keep, 'sluice.sock'), '')
      const [code] = await once(child, 'exit')
      expect(code).toBe(0)
      expect(out.trim().split('\n')).toEqual([hide, join(hide, 'spores'), keep, join(keep, 'sluice.sock')])
      expect(existsSync(join(hide, 'agent.sock'))).toBe(true)
    } finally {
      rmSync(hide, { recursive: true, force: true })
    }
  })

  it.skipIf(!CONTAINED)('runs nothing when the directory to keep is not there, and says which', () => {
    const { hide, keep } = laidOut()
    try {
      const ran = confine(['--contain', '--hide', hide, '--keep', join(hide, 'spores', 'gone'), '--no-landlock', '--', 'sh', '-c', 'echo ran'])
      expect(ran.status).toBe(126)
      expect(ran.stdout).toBe('')
      expect(ran.stderr).toMatch(/could not be laid out: cannot open .*spores\/gone: No such file or directory/)
      expect(existsSync(keep)).toBe(true)
    } finally {
      rmSync(hide, { recursive: true, force: true })
    }
  })

  it('refuses a directory to keep outside the one hidden, and either without --contain', () => {
    expect(confine(['--contain', '--hide', '/run/x', '--keep', '/run/y', '--no-landlock', '--', 'true']).stderr).toMatch(/--keep must lie under its --hide/)
    expect(confine(['--contain', '--hide', '/run/x', '--keep', '/run/x', '--no-landlock', '--', 'true']).stderr).toMatch(/--keep must lie under its --hide/)
    expect(confine(['--contain', '--hide', '/run/x', '--no-landlock', '--', 'true']).stderr).toMatch(/--hide without its --keep/)
    expect(confine(['--hide', '/run/x', '--keep', '/run/x/a', '--no-landlock', '--', 'true']).stderr).toMatch(/need --contain/)
  })

  it('is refused by runShell, which says why, when it would not be contained or the directory is not there', async () => {
    const { hide } = laidOut()
    try {
      const kept = [{ plugin: 'sluice', hide, keep: join(hide, 'spores', 'gone'), missing: 'no rules for this spore' }]
      const shell = (contain) => runShell({ command: 'echo ran', cwd: hide, outAbs: 1, errAbs: 2, confine: { writeRoot: hide, reads: [], contain, keep: kept }, env: process.env })
      expect((await shell(false)).spawnError).toMatch(/^plugin sluice shows this spore only its own part of the host .* — spore config set contain on$/)
      expect((await shell(true)).spawnError).toBe(`plugin sluice needs ${join(hide, 'spores', 'gone')}, which is not there — no rules for this spore`)
    } finally {
      rmSync(hide, { recursive: true, force: true })
    }
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

describe('the paths confine takes', () => {
  it('are as many as the runner lets a turn hand it, and no more', () => {
    const writeRoot = mkdtempSync(join(tmpdir(), 'spore-confine-paths-'))
    const system = ['/usr', '/lib', '/lib64', '/bin'].filter(path => existsSync(path))
    const reads = (count) => [...system, ...Array(count - system.length).fill('/usr')].flatMap(path => ['--read', path])
    try {
      const at = confine(['--write-root', writeRoot, ...reads(native.confineMaxPaths()), '--', 'true'])
      expect(at.status, at.stderr).toBe(0)
      const past = confine(['--write-root', writeRoot, ...reads(native.confineMaxPaths() + 1), '--', 'true'])
      expect(past.status).toBe(126)
      expect(past.stderr).toMatch(/too many read paths/)
    } finally {
      rmSync(writeRoot, { recursive: true, force: true })
    }
  })
})
