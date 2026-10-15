/**
 * What is wrong on this machine for spore, read and never repaired, each finding naming its fix.
 * The services are left to the command, which writes their units; `needsTick` says why the tick
 * timer is wanted.
 */

import { existsSync, readFileSync } from 'node:fs'
import { constants } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { getSystemErrorName } from 'node:util'
import { modelReadiness } from 'mohdel/readiness'

import { CONFIG_FILE, containing, ENVIRONMENT_FILE, MEMORY_FILE, SOURCES_FILE, readConfig, spendLimits, workspaceFor } from './config.js'
import { isWorkspace } from './discover.js'
import { list, show, sporangia } from './verbs.js'
import { containCheck, keptRefusal } from '../core/command.js'
import { containOf, listPlugins, misplaced, secretsIn, showPlugin } from '../core/plugins.js'
import { paused, SLOT_DIR, spendStop } from '../core/admission.js'
import { DEFAULT_SPORANGIUM } from '../core/sporangia.js'
import { outbox } from '../core/spore-dir.js'
import { landlockAbi } from '../isolation/sandbox.js'
import { hooksPath, loadHooks } from '../../webhook/hooks.js'

const ASSIGNMENT = /[A-Z][A-Z0-9]*_[A-Z0-9_]+=/

const are = (names) => `${names.join(', ')}, which ${names.length > 1 ? 'are' : 'is'} not set`

/**
 * What mohdel says of each model a spore names — its `model`, what it may switch to, its
 * `cell-models` — once per model: a problem when a turn on it cannot run, a note when it runs
 * unpriced, its calls then counting as $0 against `cost` and the spend limits.
 */
export async function modelFindings ({ configFile = CONFIG_FILE, readiness = modelReadiness } = {}) {
  const used = new Map()
  for (const { ws } of list({ configFile }).workspaces) {
    let shown
    try {
      shown = show({ ws, configFile })
    } catch {
      continue
    }
    const named = [shown.model, ...shown.models, ...shown.cellModels.map(entry => entry.model)]
    for (const model of new Set(named)) used.set(model, [...(used.get(model) ?? []), basename(ws)])
  }
  const findings = []
  for (const [model, spores] of used) {
    const found = await readiness(model)
    const who = spores.join(', ')
    if (!found.ready) {
      const what = !found.credential ? 'has no credential — no key, or no sign-in' : 'is not in mohdel\'s catalog'
      findings.push({ area: 'models', subject: model, severity: 'problem', problem: `${what}, so a turn of ${who} on it fails`, fix: found.fix })
    } else if (found.priced === false) {
      findings.push({ area: 'models', subject: model, severity: 'note', problem: `has no prices in mohdel's catalog: the calls of ${who} on it count as $0, so cost and spend limits never stop them`, fix: found.fix })
    }
  }
  return findings
}

export function doctor ({ configFile = CONFIG_FILE, env = process.env, abi = landlockAbi(), contain = containCheck(), root = process.getuid() === 0 || process.geteuid() === 0, slots = SLOT_DIR } = {}) {
  const findings = []
  const finding = (severity) => (area, subject, problem, fix) => findings.push({ area, subject, severity, problem, fix })
  const problem = finding('problem')
  const note = finding('note')
  const needsTick = []
  const replies = []
  const unasked = new Map()
  const startsUnasked = (name, what) => unasked.set(name, [...(unasked.get(name) ?? []), what])
  const dir = dirname(configFile)
  const environment = resolve(dir, ENVIRONMENT_FILE)
  const unsetIn = (described) => secretsIn(described).filter(variable => env[variable] === undefined)

  if (root) problem('machine', 'user', 'spore is running as root — every turn, job and router is refused', 'run spore as an ordinary user (in a container, USER or --user)')
  if (abi === -constants.errno.EOPNOTSUPP) problem('machine', 'landlock', 'is built into this kernel and not enabled at boot — every turn fails', 'add landlock to the kernel\'s lsm= boot parameter, or pass --unsafe to run unconfined')
  else if (abi < 0) problem('machine', 'landlock', `is not in this kernel (${getSystemErrorName(abi)}) — every turn fails`, 'run spore on Linux 5.13+ built with CONFIG_SECURITY_LANDLOCK, or pass --unsafe to run unconfined')
  else if (abi < 6) note('machine', 'landlock', `is version ${abi}, which cannot scope signals: a spore can signal another spore's processes and reach its abstract sockets`, 'Linux 6.12 or newer scopes both — what matters when spores of different people share one account')

  if (existsSync(environment)) {
    for (const [i, line] of readFileSync(environment, 'utf8').split('\n').entries()) {
      const text = line.trim()
      if (!text || text.startsWith('#') || text.startsWith(';')) continue
      const assigned = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(text)
      if (!assigned) problem('operator', `${environment}:${i + 1}`, 'is not KEY=value', 'one variable per line, as systemd reads it — no export, no spaces around =')
      else if (ASSIGNMENT.test(assigned[2])) problem('operator', `${environment}:${i + 1}`, `${assigned[1]}'s value holds another assignment — two lines run together`, 'put a line break before the second name')
    }
  }

  let config
  try {
    config = readConfig(configFile)
  } catch (err) {
    problem('operator', configFile, err.message, err.detail)
    return { findings, needsTick, replies }
  }

  if (!containing(config)) note('machine', 'processes', 'turns are not contained (contain off): each sees the processes and command lines of every other spore of this user', 'spore config set contain on, where this host gives unprivileged user namespaces')
  else if (!contain.contained) problem('machine', 'processes', `every turn, job and router is refused: this host cannot give them namespaces of their own (${contain.why})`, 'allow unprivileged user namespaces for spore\'s confine — on Ubuntu an AppArmor profile for it, in Docker seccomp, apparmor and systempaths unconfined (spore filters what it confines itself) — or spore config set contain off when no one else\'s spores run as this user')

  const spores = []
  const { workspaces, missing } = list({ configFile })
  for (const gone of missing) problem('spores', gone.path, `is in workspaces and ${gone.why}`, `spore config rm workspaces ${gone.path}`)
  for (const { ws } of workspaces) {
    const name = basename(ws)
    let shown
    try {
      shown = show({ ws, configFile })
    } catch (err) {
      problem('spores', name, err.message, err.detail)
      continue
    }
    spores.push({ ...shown, name })
    for (const plugin of shown.plugins) {
      if (!config.plugins?.[plugin]) problem('spores', name, `uses plugin ${plugin}, which is not allowed — every turn is refused`, `spore plugin allow ${plugin}, or drop it from plugins: in its spore.cmk`)
    }
    if (shown.plugins.every(plugin => config.plugins?.[plugin])) {
      try {
        const refused = keptRefusal(containOf(ws, { config }), containing(config) && contain.contained)
        if (refused) problem('spores', name, `${refused.problem} — every turn, job and router is refused`, refused.fix)
      } catch (err) {
        problem('spores', name, err.message, err.detail)
      }
    }
    if (shown.differs.length) note('spores', name, `${shown.differs.join(', ')} differ from what is installed`, `spore upgrade ${name}`)
    if (shown.state === 'crashed') note('spores', name, `its runner died (pid ${shown.pid}) without recording the turn`, 'the next spore send records it')
    if (shown.schedules.length) needsTick.push(`${name} has schedules`)
    if (shown.jobs.grant) needsTick.push(`${name} is granted jobs`)
    if (shown.schedules.length) startsUnasked(name, 'its schedules')
    if (shown.jobs.grant) startsUnasked(name, 'its jobs')

    const reply = config.replyTo?.[name]
    if (reply === 'terminal') problem('spores', name, 'has terminal as its default reply-to, and no terminal follows a turn it did not ask for', `name a chat for ${name} in replyTo in ${configFile}`)
    else if (reply) replies.push({ spore: name, recipient: reply, waiting: 0 })
    if (shown.lastTurnNo) {
      const waiting = new Map()
      for (const entry of outbox(ws, { state: 'pending' })) waiting.set(entry.recipient, (waiting.get(entry.recipient) ?? 0) + 1)
      for (const [recipient, count] of waiting) replies.push({ spore: name, recipient, waiting: count })
    }
  }
  for (const named of Object.keys(config.replyTo ?? {})) {
    if (!spores.some(spore => spore.name === named)) problem('operator', configFile, `replyTo names ${named}, which is not a spore here`, 'fix the name, or remove it from replyTo')
  }

  const described = (file, entries) => {
    const path = resolve(dir, file)
    if (!existsSync(path)) return
    let raw
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch (err) {
      problem('operator', path, 'is not readable JSON', err.message)
      return
    }
    for (const { what, spec, uses, wrong } of entries(raw)) {
      const users = spores.filter(uses).map(spore => spore.name)
      const report = users.length ? problem : note
      const stopped = users.length ? ` — ${users.join(', ')} cannot start a turn` : ''
      if (wrong) report('operator', path, `${what} has ${wrong.found} in ${wrong.where}${stopped}`, wrong.why)
      const unset = unsetIn(spec)
      if (unset.length) report('operator', path, `${what} wants ${are(unset)}${stopped}`, `add ${unset.join(', ')} to ${environment}`)
    }
  }
  described(SOURCES_FILE, raw => Object.entries(raw).map(([source, spec]) => ({ what: `source ${source}`, spec, uses: spore => spore.sources.includes(source), wrong: misplaced(spec) })))
  described(MEMORY_FILE, raw => [{ what: 'the vector store', spec: raw, uses: spore => spore.memory?.backend === 'vectors' }])

  const hooks = hooksPath(configFile)
  if (existsSync(hooks)) {
    try {
      for (const hook of loadHooks(hooks, env).values()) {
        for (const spore of hook.spores) {
          if (!isWorkspace(workspaceFor(spore, { config }).path)) problem('operator', hooks, `hook ${hook.name} reaches spore ${spore}, which does not exist`, `fix the name, or spore define ${spore}`)
          else startsUnasked(spore, `hook ${hook.name}`)
        }
        if (hook.maxWait) needsTick.push(`hook ${hook.name} holds deliveries`)
      }
    } catch (err) {
      problem('operator', hooks, err.message, err.detail)
    }
  }

  for (const { name, error } of sporangia({ configFile })) {
    if (error) problem('operator', `sporangium ${name}`, error, `fix it there — until then spore define${name === DEFAULT_SPORANGIUM ? '' : ` --sporangium ${name}`} is refused`)
  }

  const plugins = listPlugins({ configFile })
  for (const name of plugins.missing) problem('plugins', name, 'is allowed and not installed beside spore', `install it, or spore plugin disallow ${name}`)
  for (const plugin of plugins.plugins.filter(each => each.allowed)) {
    if (plugin.problem) {
      problem('plugins', plugin.name, plugin.problem, `spore plugin allow ${plugin.name}`)
      continue
    }
    const unset = showPlugin(plugin.name, { configFile }).secrets.filter(variable => env[variable] === undefined)
    if (unset.length) problem('plugins', plugin.name, `its sources want ${are(unset)} — a spore using it cannot start a turn`, `add ${unset.join(', ')} to ${environment}`)
  }

  for (const [name, what] of unasked) {
    if (!config.replyTo?.[name]) note('spores', name, `answers to ${what.join(', ')} reach no one: it has no default reply-to`, `add "${name}": "<place>" to replyTo in ${configFile}`)
  }

  const pause = paused({ dir: slots })
  if (pause) note('operator', 'turns', `paused since ${pause.at}${pause.why ? ` (${pause.why})` : ''} — no turn starts`, 'spore unpause')
  const stopped = spendStop({ dir: slots, spend: spendLimits(config) })
  if (stopped) note('operator', 'spend', `${stopped.message} — no turn starts and no model call is made`, stopped.detail)

  return { findings, needsTick, replies }
}
