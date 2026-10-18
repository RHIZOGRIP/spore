/**
 * `spore service`, against a stand-in for systemctl and journalctl: the units it writes, the
 * units it will not touch, and what it asks systemd to do. The real user bus is the
 * operator's to try.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { recordStarted } from '@rhizogrip/spore'
import { createServices, renderUnits } from '../src/services.js'

const ROOT = dirname(createRequire(import.meta.url).resolve('@rhizogrip/spore/package.json'))
const SPORE_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const NODE = process.execPath
const SHOWN = 'ActiveState=active\nSubState=running\nUnitFileState=enabled\nActiveEnterTimestamp=Mon 2026-09-28 12:00:00 CEST\nMainPID=4242\n'

let unitDir
let configDir
let roots
let relay

const bot = (name) => {
  mkdirSync(join(configDir, 'relay'), { recursive: true })
  writeFileSync(join(configDir, 'relay', `${name}.json`), '{}')
}

const RELAY = { what: 'a relay of yours, each bot reaching its spore', program: './bin/relay.js', instances: { dir: 'relay', ext: '.json', called: 'bot' }, check: ['--check'] }

/** A plugin offering services, installed in the test's own node_modules with its own spore, as a global install lays one out. */
const plugin = (name, services, version = '0.1.0') => {
  const dir = join(roots[0], `spore-plugin-${name}`)
  mkdirSync(join(dir, 'bin'), { recursive: true })
  writeFileSync(join(dir, 'bin', 'relay.js'), '')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `spore-plugin-${name}`, version, spore: { works: SPORE_VERSION, services } }))
  carries(dir, SPORE_VERSION)
  return dir
}

const carries = (dir, version) => {
  mkdirSync(join(dir, 'node_modules', '@rhizogrip', 'spore'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '@rhizogrip', 'spore', 'package.json'), JSON.stringify({ name: '@rhizogrip/spore', version }))
}

beforeEach(() => {
  unitDir = mkdtempSync(join(tmpdir(), 'spore-units-'))
  configDir = mkdtempSync(join(tmpdir(), 'spore-config-'))
  roots = [join(mkdtempSync(join(tmpdir(), 'spore-plugins-')), 'node_modules')]
  mkdirSync(roots[0])
  relay = plugin('relay', { relay: RELAY })
  bot('triage')
})
afterEach(() => {
  rmSync(unitDir, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
  rmSync(dirname(roots[0]), { recursive: true, force: true })
})

function standIn ({ systemd = true, check = { status: 0, stdout: 'ready', stderr: '' }, shown = SHOWN } = {}) {
  const calls = []
  const run = (command, args) => {
    calls.push([command, ...args].join(' '))
    if (command === 'systemctl' && args[1] === 'show-environment') {
      return systemd ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: 'Failed to connect to bus' }
    }
    if (command === 'systemctl' && args[1] === 'show') return { status: 0, stdout: shown, stderr: '' }
    if (command === 'systemctl' || command === 'journalctl') return { status: 0, stdout: '', stderr: '' }
    return check
  }
  return { calls, run }
}

const services = (fake, options = {}) => createServices({ unitDir, run: fake.run, cmdlineOf: () => null, node: NODE, root: ROOT, user: 'nobody-here', configDir, roots, ...options })

describe('the units spore writes', () => {
  it('start each instance of a plugin\'s service with this Node and the plugin\'s program, from one template, and read no environment file', () => {
    const unit = renderUnits('relay', { node: NODE, root: ROOT, roots })['spore-relay@.service']
    expect(unit).toContain(`ExecStart="${NODE}" "${join(relay, 'bin', 'relay.js')}" %i`)
    expect(unit).toContain('Description=spore-relay %i: a relay of yours, each bot reaching its spore')
    expect(unit).toContain('X-Spore-Service=relay')
    expect(unit).toContain('KillMode=process')
    expect(unit).toContain('RestartPreventExitStatus=2')
    expect(unit).not.toMatch(/EnvironmentFile|MemoryMax|CPUQuota/)
  })

  it('run the tick every minute from a timer', () => {
    const units = renderUnits('tick', { node: NODE, root: ROOT, roots })
    expect(Object.keys(units)).toEqual(['spore-tick.service', 'spore-tick.timer'])
    expect(units['spore-tick.service']).toContain(`ExecStart="${NODE}" "${join(ROOT, 'bin', 'spore-tick.js')}"`)
    expect(units['spore-tick.service']).toContain('Type=oneshot')
    expect(units['spore-tick.timer']).toContain('OnCalendar=minutely')
    expect(units['spore-tick.timer']).toContain('AccuracySec=1s')
    for (const text of Object.values(units)) expect(text).toContain('X-Spore-Service=tick')
  })

  it('refuse a service spore does not ship', () => {
    expect(() => renderUnits('mail', { roots })).toThrow(expect.objectContaining({ type: 'SERVICE_UNKNOWN' }))
  })
})

describe('the ssh-agent service', () => {
  const KEYS = '/home/someone/.config/spore/ssh'

  it('loads every private key in the folder beside config.json, on a socket of its own', () => {
    const unit = renderUnits('ssh-agent', { keys: KEYS, roots })['spore-ssh-agent.service']
    expect(unit).toContain('X-Spore-Service=ssh-agent')
    expect(unit).toContain('Environment=SSH_AUTH_SOCK=%t/spore-ssh-agent.socket')
    expect(unit).toContain('ExecStart=ssh-agent -D -a $SSH_AUTH_SOCK')
    expect(unit).toContain(`for key in "${KEYS}"/*`)
    expect(unit.split('\n').find(line => line.startsWith('ExecStartPost=')).match(/(?<!\$)\$(?!\$)\w+/g)).toBe(null)
  })

  it('checks the keys before writing the unit, and says what to enable next', () => {
    const fake = standIn({ check: { status: 0, stdout: '1 key(s) ready', stderr: '' } })
    const defined = services(fake, { keys: KEYS, uid: 1234 }).define('ssh-agent')
    expect(fake.calls.some(call => call.startsWith('/bin/sh -c') && call.includes(KEYS))).toBe(true)
    expect(defined.next).toBe('spore plugin allow ssh socket=/run/user/1234/spore-ssh-agent.socket')
  })
})

describe('the sluice service', () => {
  const RULES = join(process.env.XDG_CONFIG_HOME, 'spore', 'sluice')

  it('serves each spore its own rules on a socket of its own', () => {
    const unit = renderUnits('sluice', { roots })['spore-sluice.service']
    expect(unit).toContain('X-Spore-Service=sluice')
    expect(unit).toMatch(new RegExp(`ExecStart="[^"]*sluice" serve --rules-dir "${RULES}" --socket-dir %t/sluice/spores`))
    expect(unit).not.toContain('ExecStartPre')
  })

  it('checks the binary and every spore\'s rules before writing the unit, and says what to allow next', () => {
    const fake = standIn({ check: { status: 0, stdout: 'main:\nok: 2 rule(s)', stderr: '' } })
    const defined = services(fake, { uid: 1234 }).define('sluice')
    const check = fake.calls.find(call => call.startsWith('/bin/sh -c'))
    expect(check).toContain('cargo install sluicify')
    expect(check).toContain(`check --rules-dir "${RULES}"`)
    expect(defined.next).toBe('spore plugin allow sluice dir=/run/user/1234/sluice')
  })
})

describe('spore service define', () => {
  it('writes the units after the service says it can start, and reloads systemd', () => {
    const fake = standIn()
    const { units } = services(fake).define('relay@triage')
    expect(units).toEqual([join(unitDir, 'spore-relay@.service')])
    expect(fake.calls).toContain(`${NODE} ${join(relay, 'bin', 'relay.js')} triage --check`)
    expect(fake.calls.at(-1)).toBe('systemctl --user daemon-reload')
  })

  it('writes nothing for a service that would not start, and says why', () => {
    const fake = standIn({ check: { status: 2, stdout: '', stderr: 'relay: no bot token' } })
    expect(() => services(fake).define('relay@triage')).toThrow(expect.objectContaining({ type: 'SERVICE_NOT_READY', detail: 'relay: no bot token' }))
    expect(existsSync(join(unitDir, 'spore-relay@.service'))).toBe(false)
  })

  it('leaves a unit it did not write alone', () => {
    const own = '[Service]\nExecStart=/usr/bin/node /somewhere/else.js\n'
    writeFileSync(join(unitDir, 'spore-relay@.service'), own)
    expect(() => services(standIn()).define('relay@triage')).toThrow(expect.objectContaining({ type: 'SERVICE_NOT_OURS' }))
    expect(readFileSync(join(unitDir, 'spore-relay@.service'), 'utf8')).toBe(own)
  })

  it('is refused without a systemd user session', () => {
    expect(() => services(standIn({ systemd: false })).define('tick')).toThrow(expect.objectContaining({ type: 'SERVICE_NO_SYSTEMD' }))
  })
})

describe('spore service ls', () => {
  it('says what each service is doing, and which are not defined', () => {
    const fake = standIn()
    services(fake).define('relay@triage')
    const { services: rows } = services(fake).list()
    expect(rows.find(r => r.name === 'relay@triage')).toMatchObject({ defined: true, unit: 'spore-relay@triage.service', active: 'active', sub: 'running', enabled: true, pid: 4242, stale: [] })
    expect(rows.find(r => r.name === 'tick')).toMatchObject({ defined: false })
  })

  it('names a unit of the same name that spore did not write, instead of failing', () => {
    writeFileSync(join(unitDir, 'spore-relay@.service'), '[Service]\nExecStart=/x\n')
    const { services: rows } = services(standIn()).list()
    expect(rows.find(r => r.name === 'relay@triage')).toMatchObject({ defined: false, foreign: join(unitDir, 'spore-relay@.service') })
  })

  it('flags a service running an older plugin than the one installed, and only that', () => {
    const fake = standIn()
    const stateDir = mkdtempSync(join(tmpdir(), 'spore-services-state-'))
    try {
      services(fake).define('relay@triage')
      const row = () => services(fake, { stateDir }).list().services.find(r => r.name === 'relay@triage')

      expect(row().outdated).toBe(null)
      recordStarted('relay@triage', { dir: stateDir, root: relay, pid: 4242 })
      expect(row().outdated).toBe(null)
      writeFileSync(join(stateDir, 'relay@triage.json'), JSON.stringify({ version: '0.0.1', pid: 4242 }))
      expect(row().outdated).toEqual({ from: 'spore-plugin-relay', running: '0.0.1', installed: '0.1.0' })
      writeFileSync(join(stateDir, 'relay@triage.json'), JSON.stringify({ version: '0.0.1', pid: 1 }))
      expect(row().outdated).toBe(null)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('flags a service whose plugin is unchanged when the spore that plugin loads has moved under it', () => {
    const fake = standIn()
    const stateDir = mkdtempSync(join(tmpdir(), 'spore-services-state-'))
    try {
      services(fake).define('relay@triage')
      const row = () => services(fake, { stateDir }).list().services.find(r => r.name === 'relay@triage')

      recordStarted('relay@triage', { dir: stateDir, root: relay, pid: 4242 })
      expect(row().outdated).toBe(null)
      carries(relay, '99.0.0')
      expect(row().outdated).toEqual({ from: '@rhizogrip/spore', running: SPORE_VERSION, installed: '99.0.0' })
      writeFileSync(join(stateDir, 'relay@triage.json'), JSON.stringify({ version: '0.1.0', pid: 4242 }))
      expect(row().outdated).toBe(null)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('restarts every service running an older spore, and only those', () => {
    const fake = standIn()
    const stateDir = mkdtempSync(join(tmpdir(), 'spore-services-state-'))
    try {
      bot('ops')
      services(fake).define('relay@triage')
      services(fake).define('relay@ops')
      expect(services(fake, { stateDir }).restartOutdated()).toEqual([])

      writeFileSync(join(stateDir, 'relay@triage.json'), JSON.stringify({ version: '0.0.1', pid: 4242 }))
      const before = fake.calls.length
      const restarted = services(fake, { stateDir }).restartOutdated()
      expect(restarted.map(r => [r.name, r.verb, r.was, r.now])).toEqual([['relay@triage', 'restart', '0.0.1', '0.1.0']])
      expect(fake.calls.slice(before).filter(call => / restart /.test(call))).toEqual([`systemctl --user restart ${restarted[0].unit}`])
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('flags a unit written for a Node that is no longer there', () => {
    const fake = standIn()
    services(fake, { node: '/gone/node' }).define('tick')
    const row = services(fake).list().services.find(r => r.name === 'tick')
    expect(row.stale).toEqual(['/gone/node'])
  })

  it('flags a process that is not running what its unit now names', () => {
    const fake = standIn()
    services(fake).define('relay@triage')
    const program = join(relay, 'bin', 'relay.js')
    const row = (argv) => services(fake, { cmdlineOf: pid => (pid === 4242 ? argv : null) }).list().services.find(r => r.name === 'relay@triage')
    expect(row([NODE, program, 'triage']).unitChanged).toBe(false)
    expect(row([NODE, '/old/install/bin/relay.js', 'triage']).unitChanged).toBe(true)
    expect(row(null).unitChanged).toBe(false)
  })

  it('reads a service\'s journal by pattern, and takes no match for nothing rather than a failure', () => {
    const journal = (result) => {
      const fake = standIn()
      const run = (command, args) => command === 'journalctl' && args.includes('--grep') ? result : fake.run(command, args)
      services(fake).define('webhook')
      return () => services({ run }).journal('webhook', { grep: '^hook gh ', lines: 5 })
    }
    expect(journal({ status: 0, stdout: 'line one\n', stderr: '' })()).toBe('line one')
    expect(journal({ status: 1, stdout: '-- No entries --\n', stderr: '' })()).toBe('')
    expect(journal({ status: 1, stdout: '', stderr: 'Bad pattern' })).toThrow(expect.objectContaining({ type: 'SERVICE_COMMAND_FAILED', detail: 'Bad pattern' }))
  })

  it('counts the restarts systemd made', () => {
    const fake = standIn({ shown: `${SHOWN}NRestarts=7\n` })
    services(fake).define('relay@triage')
    expect(services(fake).list().services.find(r => r.name === 'relay@triage').restarts).toBe(7)
  })
})

describe('the verbs', () => {
  it('act on the unit that runs the service: the timer, for tick', () => {
    const fake = standIn()
    services(fake).define('tick')
    for (const verb of ['start', 'stop', 'restart', 'enable', 'disable']) services(fake).act(verb, 'tick')
    for (const verb of ['start', 'stop', 'restart', 'enable', 'disable']) expect(fake.calls).toContain(`systemctl --user ${verb} spore-tick.timer`)
  })

  it('refuse a service that is not defined', () => {
    expect(() => services(standIn()).act('start', 'relay@triage')).toThrow(expect.objectContaining({ type: 'SERVICE_NOT_DEFINED' }))
  })

  it('remove what spore wrote, after stopping and disabling it', () => {
    const fake = standIn()
    services(fake).define('tick')
    const { units } = services(fake).remove('tick', { yes: true })
    expect(fake.calls).toContain('systemctl --user disable --now spore-tick.timer')
    for (const unit of units) expect(existsSync(unit)).toBe(false)
  })

  it('remove one that is running only given yes, and one that is not without it', () => {
    const fake = standIn()
    services(fake).define('tick')
    expect(() => services(fake).remove('tick')).toThrow(expect.objectContaining({
      type: 'SERVICE_RUNNING',
      message: 'tick is running',
      detail: 'spore service rm tick --yes stops it and removes tick'
    }))
    expect(fake.calls.some(call => call.includes('disable'))).toBe(false)
    expect(existsSync(join(unitDir, 'spore-tick.timer'))).toBe(true)

    const stopped = standIn({ shown: SHOWN.replace('ActiveState=active', 'ActiveState=inactive') })
    const { units } = services(stopped).remove('tick')
    for (const unit of units) expect(existsSync(unit)).toBe(false)
  })

  it('do not remove a unit spore did not write', () => {
    mkdirSync(unitDir, { recursive: true })
    writeFileSync(join(unitDir, 'spore-tick.service'), '[Service]\nExecStart=/x\n')
    expect(() => services(standIn()).remove('tick')).toThrow(expect.objectContaining({ type: 'SERVICE_NOT_OURS' }))
    expect(existsSync(join(unitDir, 'spore-tick.service'))).toBe(true)
  })
})

describe('a plugin\'s services', () => {
  it('are offered whether or not the plugin is allowed, and say which package they came from', () => {
    plugin('other', { 'other-one': { what: 'runs once', program: './bin/relay.js' } })
    const fake = standIn()
    services(fake).define('other-one')
    expect(readFileSync(join(unitDir, 'spore-other-one.service'), 'utf8')).toContain(`"${join(roots[0], 'spore-plugin-other', 'bin', 'relay.js')}"\n`)
    expect(services(fake).list().services.map(r => r.name)).toEqual(expect.arrayContaining(['webhook', 'tick', 'ssh-agent', 'relay@triage', 'other-one']))
  })

  it('are refused a name spore ships or another plugin offers, which the list says', () => {
    plugin('clash', { tick: RELAY, relay: RELAY })
    const { services: rows, problems } = services(standIn()).list()
    expect(rows.filter(r => r.name === 'tick')).toHaveLength(1)
    expect(rows.some(r => r.name.startsWith('relay'))).toBe(false)
    expect(problems.map(p => [p.plugin, p.problem])).toEqual([
      ['clash', 'offers a service tick, which spore ships — uninstall one of them'],
      ['clash', 'offers a service relay, which plugin relay offers too — uninstall one of them'],
      ['relay', 'offers a service relay, which plugin clash offers too — uninstall one of them']
    ])
  })

  it('are none when the plugin does not check, and the list says why', () => {
    plugin('broken', { broken: { what: 'x', program: './bin/missing.js' } })
    const { services: rows, problems } = services(standIn()).list()
    expect(rows.some(r => r.name === 'broken')).toBe(false)
    expect(problems).toEqual([expect.objectContaining({ plugin: 'broken', problem: expect.stringMatching(/names \.\/bin\/missing\.js, which it does not contain/) })])
  })
})

describe('a service run once per bot', () => {
  it('lists each bot as its own instance, and says what to do when there is none', () => {
    const fake = standIn()
    bot('review')
    services(fake).define('relay@triage')
    const names = services(fake).list().services.map(r => r.name)
    expect(names.filter(n => n.startsWith('relay'))).toEqual(['relay@review', 'relay@triage'])

    rmSync(join(configDir, 'relay'), { recursive: true })
    const [none] = services(fake).list().services.filter(r => r.name === 'relay')
    expect(none.none).toMatch(/no bot yet — .*relay\/<bot>\.json, then spore service define relay@<bot>/)
  })

  it('acts on the instance, and refuses the service named without one, or one with no bot file', () => {
    const fake = standIn()
    services(fake).define('relay@triage')
    services(fake).act('start', 'relay@triage')
    expect(fake.calls).toContain('systemctl --user start spore-relay@triage.service')
    expect(() => services(fake).act('start', 'relay')).toThrow(expect.objectContaining({ type: 'SERVICE_NEEDS_INSTANCE' }))
    expect(() => services(fake).act('start', 'relay@nobody')).toThrow(expect.objectContaining({ type: 'SERVICE_NOT_DEFINED', detail: expect.stringMatching(/relay\/nobody\.json/) }))
    expect(() => services(fake).act('start', 'tick@x')).toThrow(expect.objectContaining({ type: 'SERVICE_UNKNOWN' }))
  })

  it('removes an instance by stopping it, and the template only when the service is named whole', () => {
    const fake = standIn()
    bot('review')
    services(fake).define('relay@triage')
    expect(() => services(fake).remove('relay')).toThrow(expect.objectContaining({ type: 'SERVICE_RUNNING', message: 'relay@review, relay@triage are running' }))
    expect(services(fake).remove('relay@triage', { yes: true }).units).toEqual([])
    expect(fake.calls).toContain('systemctl --user disable --now spore-relay@triage.service')
    expect(existsSync(join(unitDir, 'spore-relay@.service'))).toBe(true)

    const { units } = services(fake).remove('relay', { yes: true })
    expect(fake.calls).toContain('systemctl --user disable --now spore-relay@review.service')
    expect(units).toEqual([join(unitDir, 'spore-relay@.service')])
    expect(existsSync(units[0])).toBe(false)
  })
})
