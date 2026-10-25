/**
 * The services spore ships and those its installed plugins offer, as systemd user units: written,
 * started, enabled and removed by `spore service`, so nobody writes one by hand.
 *
 * Spore's own list and each plugin's manifest, not arbitrary units. Each unit carries `X-Spore-Service=<name>` — systemd
 * ignores `X-` keys — and that marker is how spore knows a unit is its own: it rewrites and
 * removes only those, and refuses to touch a unit of the same name it did not write.
 *
 * The verbs are systemd's and mean what they mean there: `start` and `stop` act now,
 * `enable` and `disable` decide whether the service starts at login. A service that runs spore
 * names the Node running this command and this package in `ExecStart`, and there is no
 * `EnvironmentFile=`: every command reads `environment` beside `config.json` itself
 * (`loadEnvironment`).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'

import { CONFIG_DIR, instanceFile, instanceNames, instancesDir, NAMES, pluginRoots, pluginServices, SERVICE_STATE_DIR, SporeError, versionAt } from '@rhizogrip/spore'

const SPORE_PACKAGE = '@rhizogrip/spore'
const ROOT = dirname(createRequire(import.meta.url).resolve(`${SPORE_PACKAGE}/package.json`))

/** The spore a plugin in `dir` loads, found as node finds it from there: its own copy on a global install. */
const sporeOf = (dir) => dirname(createRequire(join(dir, 'package.json')).resolve(`${SPORE_PACKAGE}/package.json`))

export const UNIT_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'systemd', 'user')

const MARKER = 'X-Spore-Service'

const quoted = (path) => `"${path}"`

/** A Node program's unit, restarted when it fails and never after it refuses with exit 2. */
const nodeUnit = ({ description, marker, node, program, args = '' }) => [
  '[Unit]',
  `Description=${description}`,
  `${MARKER}=${marker}`,
  '',
  '[Service]',
  `ExecStart=${quoted(node)} ${quoted(program)}${args}`,
  'Restart=on-failure',
  'RestartPreventExitStatus=2',
  'KillMode=process',
  '',
  '[Install]',
  'WantedBy=default.target'
]

/**
 * The keys the ssh-agent service loads: every private key in this folder beside `config.json`,
 * never inside a workspace, so no spore can read one. Adding or retiring a key is putting it in
 * or taking it out, then restarting the service.
 */
export const SSH_KEYS_DIR = join(CONFIG_DIR, 'ssh')

const INSTALL = { node: process.execPath, root: ROOT, keys: SSH_KEYS_DIR }
export const SSH_AGENT_SOCKET = 'spore-ssh-agent.socket'

const sshKeysCheck = (keys) => [
  'command -v ssh-agent >/dev/null && command -v ssh-add >/dev/null || { echo "no ssh-agent or ssh-add — install the OpenSSH client" >&2; exit 1; }',
  `set -- $(find ${quoted(keys)} -maxdepth 1 -type f ! -name '*.pub' 2>/dev/null)`,
  `[ $# -gt 0 ] || { echo "no private key in ${keys} — put the keys spores may use there: mkdir -m 700 -p ${keys} && ssh-keygen -t ed25519 -N '' -C '<what it is for>' -f ${keys}/<name>" >&2; exit 1; }`,
  'for key; do ssh-keygen -y -P \'\' -f "$key" >/dev/null 2>&1 || { echo "$key cannot be loaded unattended — it needs a passphrase, is readable by others (chmod 600), or is not a private key" >&2; exit 1; }; done',
  'echo "$# key(s) ready"'
].join('\n')

/**
 * The sluice broker spores reach: one socket per spore, each serving `<spore>.rules` from this
 * folder beside `config.json`; the binary is the one on PATH, or where `cargo install` puts it.
 */
export const SLUICE_RULES_DIR = join(CONFIG_DIR, 'sluice')
const sluiceBinary = () => (process.env.PATH ?? '').split(':').filter(Boolean).map(dir => join(dir, 'sluice')).find(path => existsSync(path)) ??
  join(homedir(), '.cargo', 'bin', 'sluice')

const sluiceCheck = (binary, rules) => [
  `[ -x ${quoted(binary)} ] || { echo "no sluice at ${binary} — cargo install sluicify" >&2; exit 1; }`,
  `${quoted(binary)} serve --help | grep -q -- --rules-dir || { echo "${binary} serves one rules file only — cargo install sluicify for 0.4 or later" >&2; exit 1; }`,
  `[ -d ${quoted(rules)} ] || { echo "no ${rules} — mkdir -m 700 -p ${rules}, then one <spore>.rules per spore; the plugin's examples/spore.rules is a start" >&2; exit 1; }`,
  `${quoted(binary)} check --rules-dir ${quoted(rules)}`
].join('\n')

/**
 * What each service is. `primary` is the unit `start`, `stop`, `enable` and `disable` act on;
 * `runs` the one that starts the program, whose journal says what it did. `check` runs the
 * service's own start-up checks and exits, so one that cannot start is refused before its unit
 * is written.
 *
 * A service with `instances` runs once per `<instance>.json` in the folder named after it beside `config.json`, as
 * `<name>@<instance>`: one template unit, and an instance of it per file, each started, enabled and
 * logged on its own.
 */
export const SERVICES = Object.freeze({
  webhook: {
    what: 'webhooks from any sender, each a message to the spore its hook names',
    records: true,
    primary: 'spore-webhook.service',
    runs: 'spore-webhook.service',
    check: ({ node, root }) => [node, [join(root, 'bin', 'spore-webhook.js'), '--check']],
    next: () => 'give each sender http://<host>/hook/<name> through your reverse proxy — it listens on 127.0.0.1:8742, or SPORE_WEBHOOK_LISTEN in environment',
    units: ({ node, root }) => ({
      'spore-webhook.service': nodeUnit({ description: 'spore-webhook: webhooks as messages to spores', marker: 'webhook', node, program: join(root, 'bin', 'spore-webhook.js') })
    })
  },
  api: {
    what: 'the library\'s verbs over HTTP, for callers elsewhere: send, events, show, list, stop',
    records: true,
    primary: 'spore-api.service',
    runs: 'spore-api.service',
    check: ({ node, root }) => [node, [join(root, 'bin', 'spore-api.js'), '--check']],
    next: () => 'give each caller its token and the socket or address api.json names',
    units: ({ node, root }) => ({
      'spore-api.service': nodeUnit({ description: 'spore-api: the library\'s verbs over HTTP', marker: 'api', node, program: join(root, 'bin', 'spore-api.js') })
    })
  },
  'ssh-agent': {
    what: 'holds the SSH keys spores may use, which they can sign with and never read',
    primary: 'spore-ssh-agent.service',
    runs: 'spore-ssh-agent.service',
    check: ({ keys }) => ['/bin/sh', ['-c', sshKeysCheck(keys)]],
    next: ({ uid }) => `spore plugin allow ssh socket=/run/user/${uid}/${SSH_AGENT_SOCKET}`,
    units: ({ keys }) => ({
      'spore-ssh-agent.service': [
        '[Unit]',
        'Description=spore ssh-agent: the SSH keys spores may use',
        `${MARKER}=ssh-agent`,
        '',
        '[Service]',
        `Environment=SSH_AUTH_SOCK=%t/${SSH_AGENT_SOCKET}`,
        'ExecStartPre=rm -f $SSH_AUTH_SOCK',
        'ExecStart=ssh-agent -D -a $SSH_AUTH_SOCK',
        // systemd substitutes `$x` in a command line itself, so the shell's own are written `$$x`.
        `ExecStartPost=sh -c 'until [ -S "$$SSH_AUTH_SOCK" ]; do sleep 0.1; done; for key in ${quoted(keys)}/*; do case "$$key" in *.pub) ;; *) ssh-add -q "$$key" ;; esac; done'`,
        'Restart=on-failure',
        '',
        '[Install]',
        'WantedBy=default.target'
      ]
    })
  },
  sluice: {
    what: 'runs the host commands each spore may ask for, as ~/.config/spore/sluice/<spore>.rules allows',
    primary: 'spore-sluice.service',
    runs: 'spore-sluice.service',
    check: () => ['/bin/sh', ['-c', sluiceCheck(sluiceBinary(), SLUICE_RULES_DIR)]],
    next: ({ uid }) => `spore plugin allow sluice dir=/run/user/${uid}/sluice`,
    units: () => ({
      'spore-sluice.service': [
        '[Unit]',
        'Description=spore sluice: the host commands each spore may ask for',
        `${MARKER}=sluice`,
        '',
        '[Service]',
        `ExecStart=${quoted(sluiceBinary())} serve --rules-dir ${quoted(SLUICE_RULES_DIR)} --socket-dir %t/sluice/spores`,
        'Restart=on-failure',
        '',
        '[Install]',
        'WantedBy=default.target'
      ]
    })
  },
  tick: {
    what: 'fires every schedule that is due, each minute',
    primary: 'spore-tick.timer',
    runs: 'spore-tick.service',
    check: null,
    units: ({ node, root }) => ({
      'spore-tick.service': [
        '[Unit]',
        'Description=spore tick: fires every schedule that is due',
        `${MARKER}=tick`,
        '',
        '[Service]',
        'Type=oneshot',
        `ExecStart=${quoted(node)} ${quoted(join(root, 'bin', 'spore-tick.js'))}`,
        'KillMode=process'
      ],
      'spore-tick.timer': [
        '[Unit]',
        'Description=spore tick, every minute',
        `${MARKER}=tick`,
        '',
        '[Timer]',
        'OnCalendar=minutely',
        'AccuracySec=1s',
        '',
        '[Install]',
        'WantedBy=timers.target'
      ]
    })
  }
})

/** A plugin's service, as the units spore writes for it: one Node program, started with the instance when it has them. */
function fromPlugin (found) {
  const unit = found.instances ? `spore-${found.name}@.service` : `spore-${found.name}.service`
  const named = found.instances ? (instance) => `spore-${found.name}@${instance}.service` : unit
  const instance = found.instances ? ' %i' : ''
  return {
    what: found.what,
    plugin: found.plugin,
    package: found.package,
    version: found.version,
    dir: found.dir,
    instances: found.instances,
    records: true,
    primary: named,
    runs: named,
    check: found.check && (({ node, instance }) => [node, [found.program, ...(instance === null ? [] : [instance]), ...found.check]]),
    units: ({ node }) => ({
      [unit]: nodeUnit({ description: `spore-${found.name}${instance}: ${found.what.replaceAll('%', '%%')}`, marker: found.name, node, program: found.program, args: instance })
    })
  }
}

/**
 * Spore's services and every installed plugin's. A name two of them claim goes to neither
 * plugin, since which one was found first says nothing about which the operator meant.
 */
function catalogOf (roots) {
  const { services, problems } = pluginServices(roots)
  const all = { ...SERVICES }
  const claims = Map.groupBy(services, found => found.name)
  for (const [name, claimed] of claims) {
    for (const found of claimed) {
      const others = claimed.filter(other => other !== found).map(other => `plugin ${other.plugin}`)
      if (SERVICES[name] || others.length) {
        problems.push({ plugin: found.plugin, package: found.package, problem: `offers a service ${name}, which ${SERVICES[name] ? 'spore ships' : `${others.join(' and ')} offers too`} — uninstall one of them` })
      }
    }
    if (!SERVICES[name] && claimed.length === 1) all[name] = fromPlugin(claimed[0])
  }
  return { services: all, problems }
}

/** The unit files of a service, as they are written. */
export function renderUnits (name, { roots = pluginRoots() } = {}) {
  const { base, service } = parsed(name, catalogOf(roots).services, { instanceOptional: true, verb: 'define' })
  return Object.fromEntries(Object.entries(service.units(INSTALL))
    .map(([file, lines]) => [file, `# Written by \`spore service define ${base}\`. Change it with that command, not by hand.\n${lines.join('\n')}\n`]))
}

function serviceOf (name, catalog) {
  const service = catalog[name]
  if (!service) {
    throw new SporeError(`no service called "${name}"`, {
      type: 'SERVICE_UNKNOWN',
      detail: `spore and its installed plugins offer ${Object.keys(catalog).join(', ')}`
    })
  }
  return service
}

/**
 * `telegram@reviewer` is the service `telegram`, its instance `reviewer`. `verb` is the `spore
 * service` subcommand it was named to, for the command a refusal suggests.
 */
function parsed (name, catalog, { instanceOptional = false, verb } = {}) {
  const at = name.indexOf('@')
  const base = at < 0 ? name : name.slice(0, at)
  const instance = at < 0 ? null : name.slice(at + 1)
  const service = serviceOf(base, catalog)
  if (!service.instances && instance !== null) {
    throw new SporeError(`${base} runs once, not per ${instance}`, { type: 'SERVICE_UNKNOWN', detail: `spore service ${verb} ${base}` })
  }
  if (service.instances && instance === null && !instanceOptional) {
    throw new SporeError(`${base} runs once per ${service.instances.called}: name one`, {
      type: 'SERVICE_NEEDS_INSTANCE',
      detail: `spore service ${verb} ${base}@<${service.instances.called}>, for the ${service.instances.called} in ${base}/<${service.instances.called}>.json beside config.json`
    })
  }
  if (instance !== null && !NAMES.bot.pattern.test(instance)) {
    throw new SporeError(`"${instance}" cannot be a ${service.instances.called}'s name`, { type: 'SERVICE_UNKNOWN', detail: NAMES.bot.says })
  }
  return { base, instance, service }
}

const unitOf = (field, { service, instance }) => (typeof service[field] === 'function' ? service[field](instance) : service[field])

const systemRun = (command, args) => {
  const ran = spawnSync(command, args, { encoding: 'utf8' })
  if (ran.error) return { status: null, stdout: '', stderr: ran.error.message }
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr }
}

const procCmdline = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

export function createServices ({ roots = pluginRoots() } = {}) {
  const { services: catalog, problems } = catalogOf(roots)
  const parse = (name, options) => parsed(name, catalog, options)
  const systemctl = (...args) => {
    const ran = systemRun('systemctl', ['--user', ...args])
    if (ran.status !== 0) {
      throw new SporeError(`systemctl --user ${args.join(' ')} failed`, {
        type: 'SERVICE_COMMAND_FAILED',
        detail: (ran.stderr || ran.stdout || '').trim() || `exit ${ran.status}`
      })
    }
    return ran.stdout
  }

  const requireSystemd = () => {
    const ran = systemRun('systemctl', ['--user', 'show-environment'])
    if (ran.status !== 0) {
      throw new SporeError('no systemd user session to run services in', {
        type: 'SERVICE_NO_SYSTEMD',
        detail: `spore service needs \`systemctl --user\` — ${(ran.stderr || '').trim() || `exit ${ran.status}`}`
      })
    }
  }

  const pathOf = (file) => join(UNIT_DIR, file)
  const unitsOf = (service) => service.units(INSTALL)
  const ours = (base, file) => {
    const path = pathOf(file)
    return existsSync(path) && readFileSync(path, 'utf8').split('\n').includes(`${MARKER}=${base}`)
  }
  const written = ({ base, service }) => Object.keys(unitsOf(service)).every(file => ours(base, file))

  const defined = (one) => written(one) && (one.instance === null || existsSync(instanceFile(one.base, one.instance)))

  const foreign = ({ base, service }) => Object.keys(unitsOf(service))
    .find(file => existsSync(pathOf(file)) && !ours(base, file)) ?? null

  const refuseForeign = (one, name) => {
    const file = foreign(one)
    if (file) {
      throw new SporeError(`${pathOf(file)} was not written by spore`, {
        type: 'SERVICE_NOT_OURS',
        detail: `remove it — systemctl --user disable --now ${file}; rm ${pathOf(file)} — then spore service define ${name}`
      })
    }
  }

  const requireDefined = (one, name) => {
    refuseForeign(one, name)
    if (!defined(one)) {
      throw new SporeError(`${name} is not defined`, {
        type: 'SERVICE_NOT_DEFINED',
        detail: one.instance !== null && !existsSync(instanceFile(one.base, one.instance))
          ? `there is no ${instanceFile(one.base, one.instance)}`
          : `spore service define ${name} writes its unit`
      })
    }
  }

  const execPaths = ({ service }) => {
    const text = Object.keys(unitsOf(service)).map(file => readFileSync(pathOf(file), 'utf8')).find(unit => unit.includes('\nExecStart='))
    const exec = text.split('\n').find(line => line.startsWith('ExecStart='))
    return [...exec.matchAll(/"([^"]+)"/g)].map(found => found[1])
  }

  // The Node and the script a unit starts, read back from it: either gone means the unit was
  // written for a checkout or an install that has since moved.
  const stale = (one) => execPaths(one).filter(path => !existsSync(path))

  // A process started before its unit was last written runs what the unit used to name.
  const unitChanged = (one, pid) => {
    const argv = pid && procCmdline(pid)
    return Boolean(argv) && !execPaths(one).every(path => argv.includes(path))
  }

  const stateOf = (unit) => {
    const fields = Object.fromEntries(systemctl('show', unit, '-p', 'ActiveState,SubState,UnitFileState,ActiveEnterTimestamp,MainPID,NRestarts')
      .trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
    return {
      active: fields.ActiveState,
      sub: fields.SubState,
      enabled: fields.UnitFileState === 'enabled',
      since: fields.ActiveEnterTimestamp || null,
      pid: Number(fields.MainPID) || null,
      restarts: Number(fields.NRestarts) || 0
    }
  }

  // The version a running service recorded, when it is the process running now and not the
  // one installed — of spore, of the plugin that offers it, or of the spore that plugin loads.
  // A service that recorded nothing, or a record left by an earlier process, says nothing either way.
  const outdated = (name, { service }, pid) => {
    const record = join(SERVICE_STATE_DIR, `${name}.json`)
    if (!service.records || !pid || !existsSync(record)) return null
    const started = JSON.parse(readFileSync(record, 'utf8'))
    if (started.pid !== pid) return null
    const installed = service.plugin ? service.version : versionAt(ROOT)
    if (started.version !== installed) return { from: service.package ?? 'spore', running: started.version, installed }
    if (!service.plugin || started.spore === undefined) return null
    const loads = versionAt(sporeOf(service.dir))
    return started.spore !== loads ? { from: SPORE_PACKAGE, running: started.spore, installed: loads } : null
  }

  const row = (name) => {
    const one = parse(name, { verb: 'show' })
    const { service } = one
    const other = foreign(one)
    if (other) return { name, what: service.what, defined: false, foreign: pathOf(other) }
    if (!defined(one)) return { name, what: service.what, defined: false }
    const unit = unitOf('primary', one)
    const state = stateOf(unit)
    return { name, what: service.what, defined: true, unit, ...state, stale: stale(one), unitChanged: unitChanged(one, state.pid), outdated: outdated(name, one, state.pid) }
  }

  const rows = (base) => {
    const service = serviceOf(base, catalog)
    if (!service.instances) return [row(base)]
    const names = instanceNames(base)
    if (!names.length) {
      return [{ name: base, what: service.what, defined: false, none: `no ${service.instances.called} yet — ${instancesDir(base)}/<${service.instances.called}>.json, then spore service define ${base}@<${service.instances.called}>` }]
    }
    return names.map(instance => row(`${base}@${instance}`))
  }

  return {
    list () {
      requireSystemd()
      return {
        linger: existsSync(join('/var/lib/systemd/linger', userInfo().username)),
        services: Object.keys(catalog).flatMap(rows),
        problems
      }
    },

    show (name) {
      requireSystemd()
      const one = parse(name, { verb: 'show' })
      const shown = row(name)
      if (!shown.defined) return shown
      const units = Object.keys(unitsOf(one.service)).map(pathOf)
      const log = systemRun('journalctl', ['--user', '-u', unitOf('runs', one), '-n', '10', '--no-pager', '-o', 'short-iso']).stdout.trim()
      return { ...shown, units, log }
    },

    define (name) {
      const one = parse(name, { verb: 'define' })
      const { service, instance } = one
      requireSystemd()
      refuseForeign(one, name)
      if (service.check) {
        const [command, args] = service.check({ ...INSTALL, instance })
        const checked = systemRun(command, args)
        if (checked.status !== 0) {
          throw new SporeError(`${name} would not start`, {
            type: 'SERVICE_NOT_READY',
            detail: (checked.stderr || checked.stdout || '').trim() || `exit ${checked.status}`
          })
        }
      }
      mkdirSync(UNIT_DIR, { recursive: true })
      const units = []
      for (const [file, text] of Object.entries(renderUnits(one.base, { roots }))) {
        writeFileSync(pathOf(file), text)
        units.push(pathOf(file))
      }
      systemctl('daemon-reload')
      return { name, units, next: service.next ? service.next({ uid: process.getuid() }) : null }
    },

    act (verb, name) {
      requireSystemd()
      const one = parse(name, { verb })
      requireDefined(one, name)
      const unit = unitOf('primary', one)
      systemctl(verb, unit)
      return { name, unit, verb, ...stateOf(unit) }
    },

    /** Every service still running a spore older than the one installed, restarted. */
    restartOutdated () {
      requireSystemd()
      return Object.keys(catalog).flatMap(rows)
        .filter(each => each.outdated)
        .map(each => ({ ...this.act('restart', each.name), was: each.outdated.running, now: each.outdated.installed }))
    },

    /**
     * An instance is stopped and disabled, and its template stays for the others. The service
     * itself, named without one, is every instance stopped and disabled and the template removed.
     * Stopping one that is running takes `yes`.
     */
    remove (name, { yes = false } = {}) {
      requireSystemd()
      const one = parse(name, { instanceOptional: true, verb: 'rm' })
      const { service, instance } = one
      if (instance !== null) requireDefined(one, name)
      else {
        refuseForeign(one, name)
        if (!written(one)) {
          throw new SporeError(`${name} is not defined`, { type: 'SERVICE_NOT_DEFINED', detail: `spore service define ${name}${service.instances ? `@<${service.instances.called}>` : ''} writes its unit` })
        }
      }
      const instances = instance !== null ? [instance] : service.instances ? instanceNames(one.base) : [null]
      const running = instances.filter(each => !['inactive', 'failed'].includes(stateOf(unitOf('primary', { service, instance: each })).active))
      if (running.length && !yes) {
        const named = running.map(each => (each === null ? one.base : `${one.base}@${each}`))
        throw new SporeError(`${named.join(', ')} ${named.length > 1 ? 'are' : 'is'} running`, {
          type: 'SERVICE_RUNNING',
          detail: `spore service rm ${name} --yes stops ${named.length > 1 ? 'them' : 'it'} and removes ${name}`
        })
      }
      if (instance !== null) {
        systemctl('disable', '--now', unitOf('primary', one))
        return { name, units: [] }
      }
      for (const each of instances) systemctl('disable', '--now', unitOf('primary', { service, instance: each }))
      const removed = Object.keys(unitsOf(service)).map(pathOf)
      for (const path of removed) rmSync(path)
      systemctl('daemon-reload')
      return { name, units: removed }
    },

    /** The unit whose journal says what the service did. */
    log (name) {
      requireSystemd()
      const one = parse(name, { verb: 'log' })
      requireDefined(one, name)
      return unitOf('runs', one)
    },

    /** The last `lines` journal lines of a service matching `grep`, a PCRE2 pattern. */
    journal (name, { grep, lines }) {
      const unit = this.log(name)
      const ran = systemRun('journalctl', ['--user', '-u', unit, '--grep', grep, '-n', String(lines), '--no-pager', '-o', 'short-iso'])
      const printed = ran.stdout.trim()
      if (printed === '-- No entries --') return ''
      if (ran.status !== 0) {
        throw new SporeError(`journalctl --user -u ${unit} failed`, { type: 'SERVICE_COMMAND_FAILED', detail: (ran.stderr || '').trim() || `exit ${ran.status}` })
      }
      return printed
    }
  }
}
