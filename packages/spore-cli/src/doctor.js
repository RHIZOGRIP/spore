import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { getSystemErrorName } from 'node:util'

import { boundary, describeHost, doctor, loadMohdelEnvironment, modelFindings } from '@rhizogrip/spore'

import { createServices } from './services.js'

const AREAS = ['operator', 'spores', 'models', 'plugins', 'services', 'machine']

/**
 * A place `<kind>:<instance>/…` is served by the service `<kind>@<instance>` — `telegram:triage/42`
 * by `telegram@triage` — so a default reply-to, or answers waiting in an outbox, name the service
 * that has to be running for them to arrive. A place of no such shape names none.
 */
function servedBy (recipient) {
  const named = /^([a-z][a-z0-9-]*):([^/]+)\//.exec(recipient)
  return named && `${named[1]}@${named[2]}`
}

function serviceFindings (services, needsTick, replies) {
  const findings = []
  const problem = (subject, what, fix) => findings.push({ area: 'services', subject, severity: 'problem', problem: what, fix })
  const note = (subject, what, fix) => findings.push({ area: 'services', subject, severity: 'note', problem: what, fix })
  let listed
  try {
    listed = services.list()
  } catch (err) {
    if (err.type !== 'SERVICE_NO_SYSTEMD') throw err
    if (needsTick.length) problem('tick', `${needsTick.join(', ')}, and there is no systemd user session to run the tick timer`, 'run spore tick every minute some other way')
    return findings
  }
  for (const { plugin, problem: what } of listed.problems) problem(`plugin ${plugin}`, `offers no service: ${what}`, `fix or uninstall ${plugin}`)
  for (const row of listed.services) {
    if (row.foreign) problem(row.name, `${row.foreign} was not written by spore`, `remove it, then spore service define ${row.name}`)
    if (!row.defined) continue
    for (const gone of row.stale) problem(row.name, `its unit starts ${gone}, which is gone`, `spore service define ${row.name}`)
    if (row.unitChanged) problem(row.name, `pid ${row.pid} runs what its unit named before it was last written`, `spore service restart ${row.name}`)
    if (row.outdated) problem(row.name, `runs ${row.outdated.from} ${row.outdated.running}, and ${row.outdated.installed} is installed`, `spore service restart ${row.name}`)
    if (row.enabled && row.active !== 'active') problem(row.name, `is enabled and ${row.active} (${row.sub})`, `spore service log ${row.name}`)
    if (row.restarts) note(row.name, `systemd has restarted it ${row.restarts} time${row.restarts > 1 ? 's' : ''}`, `spore service log ${row.name}`)
  }
  const tick = listed.services.find(row => row.name === 'tick')
  if (needsTick.length && !(tick.defined && tick.active === 'active')) {
    problem('tick', `${needsTick.join(', ')}, and the tick timer is ${tick.defined ? tick.active : 'not defined'} — nothing fires them`, tick.defined ? 'spore service enable tick, then spore service start tick' : 'spore service define tick, then enable and start it')
  }
  if (!listed.linger && listed.services.some(row => row.enabled)) note('linger', 'is off, so every service stops when you log out', 'loginctl enable-linger')
  for (const { spore, recipient, waiting } of replies) {
    const name = servedBy(recipient)
    if (!name) continue
    const row = listed.services.find(each => each.name === name)
    if (row?.defined && row.active === 'active') continue
    const is = !row ? 'no service here' : row.defined ? row.active : 'not defined'
    const fix = !row ? `install the plugin that serves ${name.split('@')[0]}, or change where ${spore} answers` : row.defined ? `spore service start ${name}` : `spore service define ${name}, then start it`
    problem(name, waiting ? `${waiting} answer${waiting > 1 ? 's' : ''} of ${spore} wait for it to deliver them, and it is ${is}` : `${spore} answers to ${recipient} by default, and ${name} is ${is}`, fix)
  }
  return findings
}

export async function diagnose ({ services = createServices() } = {}) {
  loadMohdelEnvironment()
  const { findings, needsTick, replies } = doctor()
  const tried = await boundary()
  return { findings: [...findings, ...tried.findings, ...await modelFindings(), ...serviceFindings(services, needsTick, replies)], boundary: tried.boundary, host: describeHost() }
}

const ISSUES = createRequire(import.meta.url)('../package.json').bugs.url

/**
 * A diagnosis as a GitHub issue its reader files, or not: `{ title, body, url }`, the body this
 * machine, the boundary as tried and what doctor found on the machine — never a spore, a model or
 * a setting — with the home directory written `~`, and `url` the issue form filled with it.
 */
export function hostReport ({ host, boundary, findings }) {
  const landlock = host.landlock < 0 ? `not in this kernel (${getSystemErrorName(host.landlock)})` : `ABI ${host.landlock}`
  const rows = [
    ['spore', host.spore],
    ['Node', `${host.node}, SQLite ${host.sqlite}`],
    ['system', `${host.system}, ${host.arch}, in ${host.runsIn}`],
    ['kernel', host.kernel],
    ['Landlock', landlock],
    ['AppArmor', host.appArmor ?? 'no switch for user namespaces'],
    ['namespaces', host.contain.contained ? 'contained' : host.contain.why]
  ]
  const machine = findings.filter(found => found.area === 'machine')
  const body = [
    '| | |',
    '|---|---|',
    ...rows.map(([name, value]) => `| ${name} | ${value} |`),
    '',
    '**Boundary**',
    '',
    ...(boundary.length ? boundary.map(one => `- ${one.outcome} — ${one.tried}${one.outcome === 'refused' ? '' : ` (${one.why})`}`) : ['- not tried']),
    '',
    '**Found on the machine**',
    '',
    ...(machine.length ? machine.map(found => `- ${found.severity}: ${found.subject} — ${found.problem}`) : ['- nothing'])
  ].join('\n').split(homedir()).join('~')
  const title = `Host report: ${host.system}, ${host.kernel}`
  const url = `${ISSUES}/new?${Object.entries({ template: 'host-report.yml', title, report: body }).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`
  return { title, body, url }
}

export function renderReport ({ body, url }) {
  console.log(`${body}\n\nto share it, open this and submit the issue — nothing is sent until you do:\n${url}`)
}

const OUTCOME_WIDTH = 9

export function renderDoctor ({ findings, boundary }) {
  for (const area of AREAS) {
    const here = findings.filter(found => found.area === area)
    if (!here.length) continue
    console.log(area)
    for (const found of here) {
      console.log(`  ${found.severity === 'note' ? 'note: ' : ''}${found.subject} — ${found.problem}`)
      if (found.fix) console.log(found.fix.split('\n').map(line => `      ${line}`).join('\n'))
    }
  }
  if (boundary.length) {
    console.log('boundary — what a turn\'s commands tried on this host')
    for (const one of boundary) console.log(`  ${one.outcome.padEnd(OUTCOME_WIDTH)} ${one.tried}${one.outcome === 'refused' ? '' : ` — ${one.why}`}`)
  }
  const problems = findings.filter(found => found.severity === 'problem').length
  const notes = findings.length - problems
  const total = findings.length ? `${problems} problem${problems === 1 ? '' : 's'}, ${notes} note${notes === 1 ? '' : 's'}` : 'nothing wrong'
  console.log(findings.length || boundary.length ? `\n${total}` : total)
}
