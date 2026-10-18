/**
 * Rendering for the read-only verbs. Parsing lives in `bin/spore.js`, the answers live in
 * `verbs.js`, and this is only the part that decides what a person sees.
 *
 * `--json` prints the library's own shape, one object, so anything scripting against this
 * reads the same thing an embedder would and does not parse a table. A verb's exit code is a
 * function of that object, so it is the same with `--json` as without.
 */

import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import {
  addTo, allowPlugin, annotate, billingFor, changeText, define, defaultModel, disallowPlugin, durationText,
  edit, extend, getKey, jobs, list, listApprovals, listPlugins, log, pause, precursors, remake, remove,
  removeFrom, removeSchedule, requestApproval, runningLines, schedules, setDefaultModel, setKey, setSchedule, settings,
  show, showPlugin, sql, stateWord, stopJob, switchModel, tick, tickReport, unmetered, unpause, upgrade, usage, wrap, CONFIG_FILE, DEFAULT_SPORANGIUM
} from '@rhizogrip/spore'
import { diagnose, renderDoctor } from './doctor.js'
import { hook } from './hooks.js'
import { createServices } from './services.js'
import { saidBy, saidText } from '../tui/conversation.js'

const STATE_WIDTH = 9

const size = (bytes) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit ? value.toFixed(1) : value}${units[unit]}`
}

const tilde = (path) => (path === homedir() || path.startsWith(homedir() + '/') ? `~${path.slice(homedir().length)}` : path)

const line = (row, under) => {
  const where = under && row.ws.startsWith(under) ? row.ws.slice(under.length + 1) || '.' : row.ws
  const spend = row.treeUsd ? `$${row.treeUsd.toFixed(4)}` : ''
  const works = row.definitionError ? '  (its spore.cmk does not parse)' : row.writes.map(path => `  → ${tilde(path)}`).join('')
  const over = row.historyOver ? '  (history over its bound)' : ''
  return `  ${stateWord(row).padEnd(STATE_WIDTH)} ${String(row.lastTurnNo).padStart(4)} turns ${spend.padStart(9)} ${size(row.bytes).padStart(8)}  ${where}${works}${over}`
}

const block = (title, rows, under) => {
  if (!rows.length) return
  console.log(title)
  for (const row of rows.sort((a, b) => a.ws.localeCompare(b.ws))) console.log(line(row, under))
}

function renderList (result) {
  if (!result.configured) {
    console.error(`spore: no ${result.file}\n` +
      '       it names where workspaces live and nothing else — "home" is the directory\n' +
      '       spores are made in, "workspaces" lists any that live outside it\n' +
      '       spore config set home <dir>')
    return
  }
  for (const skip of result.missing) console.error(`spore: skipped ${skip.path} — ${skip.why}`)
  if (result.paused) console.log(`your spores are ${pausedText(result.paused)} — no turn starts until spore unpause\n`)
  const limited = spendText(result.spend)
  if (limited) console.log(`your spores have spent ${limited}\n`)
  if (!result.contain) console.log('turns are not contained (contain off): each sees every other spore\'s processes\n')

  const home = result.workspaces.filter(row => row.from === result.home)
  const outside = result.workspaces.filter(row => row.from !== result.home)

  if (!result.workspaces.length) {
    if (result.asked) console.log(`no spores in ${result.home} — spore ls alone lists your home, spore show <name> shows one spore`)
    else if (result.home) console.log(`no spores yet — spore define <name> makes one in ${result.home}`)
    else console.log('nowhere configured to look — spore config set home <dir>')
    return
  }
  block(result.home, home, result.home)
  block('outside home', outside, null)
}

const listExit = (result) => (result.configured ? 0 : 2)

/** `today $4.12 of $20.00 · October $81.30 of $300.00`, the windows a limit is set on; null with none. */
const spendText = ({ date, day, month, limits }) => {
  const of = (spent, limit) => `$${spent.toFixed(2)} of $${limit.toFixed(2)}${spent >= limit ? ' — reached, no turn starts' : ''}`
  const monthName = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })
  const parts = [
    limits.day === null ? null : `today ${of(day, limits.day)}`,
    limits.month === null ? null : `${monthName} ${of(month, limits.month)}`
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

function renderModels ({ model, models }) {
  console.log(`runs on ${model}`)
  console.log(models.length ? `or: ${models.join(', ')} — spore model <name> <model> switches from the next turn` : 'offers no other — models: [<provider>/<name>, …] in its spore.cmk adds some')
}

function renderSwitch ({ model, was }) {
  console.log(model === was ? `already runs on ${model}` : `runs on ${model} from the next turn — it ran on ${was}`)
}

function renderDefine (result) {
  if (result.seeded) {
    console.error(`spore: seeded ${result.seeded} from the package's default sporangium\n` +
      '       every spore is made over it — edit it to change them')
  }
  if (result.redefined) console.error(`spore: redefined ${result.redefined.from} → ${result.redefined.to}, keeping the conversation`)
  if (result.already) console.error('spore: already defined — pass --definition to replace what it is, or edit its spore.cmk')
  if (result.cloned) {
    const { precursors, programs } = result.cloned
    console.error(`spore: cut from ${result.cloned.from}\n` +
      `       carried ${precursors.length} precursor(s) and ${programs.length} program(s); the conversation stayed behind`)
  }
  if (result.sporangium && result.sporangium !== DEFAULT_SPORANGIUM && !result.cloned) console.error(`spore: made from the sporangium ${result.sporangium}`)
  if (result.remembered) console.error(`spore: recorded in ${result.file}, so spore ls finds it outside home`)
  console.log(result.ws)
}

const bounds = (l, billing) => {
  const money = unmetered(billing)
    ? `not metered · ${billing.label}${billing.usage ? `, ${billing.usage}` : ''}`
    : `$${l.cost.soft.toFixed(2)}/$${l.cost.hard.toFixed(2)}`
  return `${l.rounds.soft}/${l.rounds.hard} rounds · ${money} · ${l.wall.soft / 60000}/${l.wall.hard / 60000}m`
}

const modelLine = (model, billing) => `${model}${billing === null ? '  (a provider mohdel does not know)' : ''}`

export function renderHeader (ws, grant) {
  console.error([
    `spore  ${ws}`,
    `       ${modelLine(grant.model, grant.billing)} · tools: ${grant.tools.join(', ')}`,
    `       limits: ${bounds(grant.limits, grant.billing)}  (soft wraps, hard stops)`
  ].join('\n'))
}

function renderShow (result) {
  const line = (label, value) => console.log(`  ${label.padEnd(10)} ${value}`)
  console.log(result.ws)
  line('state', `${stateWord(result)}${result.pid ? `  pid ${result.pid}  since ${result.startedAt}` : ''}`)
  line('name', result.name)
  if (result.description) line('description', result.description)
  line('sporangium', result.sporangium)
  line('model', modelLine(result.model, result.billing))
  if (result.models.length) line('or', result.models.join(', '))
  if (result.cellModels.length) line('cell models', result.cellModels.map(named => `${named.name}=${named.model}`).join(', '))
  line('tools', result.tools.length ? result.tools.join(', ') : 'none')
  line('limits', bounds(result.limits, result.billing))
  if (result.turnLimits) for (const [i, one] of runningLines(result.turnLimits, result.extend).entries()) line(i ? '' : 'this turn', one)
  if (result.sources?.length) {
    line('sources', result.sources.map(name => {
      const narrowed = Object.entries(result.scopes?.[name] || {}).map(([p, v]) => `${p}=${v.join('|')}`)
      return narrowed.length ? `${name} (${narrowed.join(' ')})` : name
    }).join(', '))
  }
  if (result.reads?.length) line('reads', result.reads.map(r => `${r.name} → ${r.path}`).join(', '))
  if (result.writes?.length) line('writes', result.writes.map(w => `${w.name} → ${w.path}`).join(', '))
  if (result.memory) line('memory', `${result.memory.backend}  push ${result.memory.push}  pull ${result.memory.pull}`)
  line('messages', `${result.messages}${result.waiting ? `  (${result.waiting} waiting)` : ''}`)
  if (result.paused) line('spores', `${pausedText(result.paused)} — no turn starts until spore unpause`)
  if (result.held.length) {
    const next = result.held.reduce((first, one) => (one.releaseAt < first.releaseAt ? one : first))
    line('held', `${result.held.length} deliveries routed to wait — next at ${next.releaseAt} (${next.origin})`)
  }
  if (result.cells.runs) {
    const by = Object.entries(result.cells.origins).map(([origin, runs]) => `${origin} ${runs}`).join(', ')
    line('cells', `${result.cells.runs} outside turns in the last day, $${result.cells.costUsd.toFixed(4)} — ${by}`)
  }
  if (result.jobs.grant || result.jobs.running.length) {
    if (!result.jobs.running.length) line('jobs', `none running — ${jobGrant(result.jobs.grant)}`)
    for (const [i, job] of result.jobs.running.entries()) line(i ? '' : 'jobs', runningJob(job))
  }
  line('turns', `${result.lastTurnNo}${result.last?.stopReason ? `  last ${result.last.stopReason}` : ''}${result.endedAt ? `  ${result.endedAt}` : ''}`)
  if (result.history) line('history', historyLine(result.history))
  line('spend', unmetered(result.billing) ? `not metered · ${result.billing.label}` : `$${result.treeUsd.toFixed(6)}`)
  line('work', `${result.workUnits} units  (${result.workUnitsOwn} own rounds, ${result.workUnitsChildren} in cells)`)
  if (result.deliverables.length) {
    const shown = result.deliverables.slice(0, 5).map(f => `${f.path} (${f.mime}, ${f.bytes}b)`)
    const rest = result.deliverables.length - shown.length + result.deliverablesMore
    line('delivered', shown.join('\n' + ' '.repeat(13)) + (rest ? `\n${' '.repeat(13)}…and ${rest} more` : ''))
  }
  if (result.precursors.length) line('precursors', result.precursors.join(', '))
  if (result.plugins.length) line('plugins', result.plugins.join(', '))
  if (result.differs.length) line('docs', `${result.differs.join(', ')} differ from what is installed — spore upgrade ${basename(result.ws)}`)
  const { disk } = result
  line('disk', `${size(disk.total)} — data ${size(disk.data)} · records ${size(disk.state)} · streams ${size(disk.calls)} · sent ${size(disk.inbox)} · other ${size(disk.other)}`)
  for (const [i, one] of result.schedules.entries()) line(i ? '' : 'schedules', scheduleLine(one))
  if (result.scheduleBound) {
    const b = result.scheduleBound
    line('clock', `may keep ${b.count}, ${b.interval / 60000}m apart at the closest — at most ${b.perDay} turns a day, $${b.nominalCost.toFixed(2)} nominal`)
    line('', 'a turn stops taking model calls at its hard cost, and pays for the ones still running then')
  }
}

// One line per schedule a pass did something about, for the journal a timer writes to. A
// schedule that is not due yet, or will never fire again, is left out: every pass would
// repeat it.
function renderEdit (result) {
  if (!result.edited) {
    const why = {
      unchanged: 'no change',
      editor: `the editor exited ${result.status}; spore.cmk is as it was`,
      refused: 'not saved; spore.cmk is as it was'
    }[result.why]
    console.error(`spore: ${why}`)
    return
  }
  console.log(`edited ${join(result.ws, 'spore.cmk')}`)
  for (const line of result.changes) console.log(`  ${line}`)
  if (result.running) console.log('a turn is running: this applies from the next one, and extend.* to spore extend at once')
}

const editExit = (result) => (result.edited || result.why === 'unchanged' ? 0 : 1)

function openInEditor (file) {
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi'
  return spawnSync('sh', ['-c', `${editor} "$1"`, 'sh', file], { stdio: 'inherit' }).status ?? 1
}

async function editAgain (error) {
  console.error(`spore: ${error}`)
  if (!process.stdin.isTTY) return false
  const prompt = createInterface({ input: process.stdin, output: process.stderr })
  const answer = await prompt.question('edit again? [Y/n] ')
  prompt.close()
  return !/^n/i.test(answer.trim())
}

function renderChange (answer) {
  if (answer.refused) {
    console.error(`spore: ${changeText(answer)}`)
    return
  }
  console.log(changeText(answer))
}

const changeExit = (answer) => (answer.refused ? 1 : 0)

const renderAnnotation = (text) => (answer) => {
  if (answer.refused) {
    console.error('spore: nothing is running — a line is shown under a running turn and goes when it ends')
    return
  }
  console.log(text === null ? 'its line was taken away' : 'shown under the running turn')
}

const pausedText = (mark) => `paused${mark.at ? ` since ${mark.at}` : ''}${mark.why ? ` (${mark.why})` : ''}`

function renderPause (result) {
  console.log(result.already ? `already ${pausedText(result.mark)}` : pausedText(result.mark))
  for (const ws of result.turns) console.log(`  stopping the turn in ${ws}`)
  for (const job of result.jobs) console.log(`  stopping the job ${job.name} in ${job.ws}`)
  if (!result.turns.length && !result.jobs.length) console.log('  nothing was running')
  console.log('no turn starts until spore unpause — messages and webhooks are refused meanwhile, schedules wait')
}

function renderUnpause (result) {
  if (!result.unpaused) {
    console.error('spore: your spores are not paused')
    return
  }
  console.log(`unpaused — it was ${pausedText(result.mark)}; held deliveries and due schedules go at the next spore tick`)
}

const unpauseExit = (result) => (result.unpaused ? 0 : 1)

function renderTick (result) {
  for (const line of tickReport(result).lines) console.log(line)
}

export function scheduleLine (one) {
  const when = one.at ? `at ${one.at}` : `${one.when}  ${one.tz}`
  const where = one.why ? `  ${one.why}` : one.next ? `  next ${one.next}` : one.slot ? `  for ${one.slot}` : ''
  return `${one.name}  ${when}  ${one.state}${where}`
}

const jobGrant = (grant) => grant
  ? `${grant.count} at once, ${durationText(grant.wall)} each${grant.maxWait ? `, routed within ${durationText(grant.maxWait)}` : ''}${grant.perDay ? `, ${grant.perDay} triage cells a day` : ''}`
  : 'none granted'

export const runningJob = (job) => `${job.name} · ${durationText(Date.now() - Date.parse(job.startedAt))} of ${durationText(job.wallMs)}${job.progress ? ` · ${job.progress}` : ''}`

function renderJobs (result) {
  console.log(`granted: ${jobGrant(result.grant)}`)
  for (const job of result.jobs) {
    const how = job.status === 'running'
      ? runningJob(job)
      : `${job.name} · ${job.status}${job.exit !== null ? ` ${job.exit}` : job.signal ? ` ${job.signal}` : ''} after ${durationText(Date.parse(job.endedAt) - Date.parse(job.startedAt))}`
    console.log(`  ${when(job.startedAt)}  ${how}`)
  }
  if (!result.jobs.length) console.log('  none has run here')
}

function renderSchedules (result) {
  for (const one of result.schedules) console.log(scheduleLine(one))
  if (!result.schedules.length) console.log('none — nothing here is said by the clock')
}

function renderApprovals (result) {
  const ended = (one) => {
    if (one.state === 'answered') {
      const host = one.outcome === 'failed' ? `, not confirmed — ${one.reason}` : one.outcome ? `, ${one.outcome}` : ''
      return `${one.choice} by ${one.answererName}${host}`
    }
    if (one.state === 'refused') return `refused — ${one.reason}`
    if (one.state === 'expired') return 'expired'
    return `${one.state}, until ${when(one.until)}`
  }
  for (const one of result.approvals) console.log(`${one.id}  ${when(one.at)}  ${one.place}  ${ended(one)}`)
  if (!result.approvals.length) console.log('none — nothing was asked here')
}

async function readStdin () {
  if (process.stdin.isTTY) return ''
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const when = (iso) => (iso ? iso.replace('T', ' ').slice(0, 19) : '—'.padEnd(19))

const cut = (text) => (text.length > 60 ? text.slice(0, 57) + '…' : text)
const quoted = (entries) => entries.map(entry => `${saidBy(entry) ? `${saidBy(entry)}: ` : ''}${JSON.stringify(cut(saidText(entry)))}`).join(' ')

function renderLog (result) {
  if (!result.turns.length && !result.waiting.length && !result.setAside.length && !result.held.length) {
    console.log('nothing has been said here yet')
    return
  }
  const why = (turn) => {
    if (!turn.error) return ''
    const detail = turn.detail ? ` — ${turn.detail.split('\n')[0]}` : ''
    const text = `${turn.error}${detail}`
    return `${text.length > 100 ? `${text.slice(0, 99)}…` : text}  `
  }
  for (const turn of result.turns) {
    console.log(`  ${when(turn.endedAt)}  ${(turn.stopReason || '—').padEnd(12)} ${String(turn.rounds).padStart(3)}r ` +
      `${('$' + turn.treeUsd.toFixed(4)).padStart(9)} ${String(turn.workUnits).padStart(4)}u  ${why(turn)}${quoted(turn.asked)}`)
  }
  // The time column is when a turn ended, and a waiting message has not been answered by
  // one. Blank says that; when it was said is in the record for anyone who needs it.
  for (const entry of result.setAside) {
    console.log(`  ${' '.repeat(19)}  ${'set aside'.padEnd(12)} ${' '.repeat(19)}  ${quoted([entry])}`)
  }
  for (const entry of result.waiting) {
    console.log(`  ${' '.repeat(19)}  ${'waiting'.padEnd(12)} ${' '.repeat(19)}  ${quoted([entry])}`)
  }
  for (const one of result.held) {
    console.log(`  ${' '.repeat(19)}  ${one.state.padEnd(12)} ${' '.repeat(19)}  schedule ${one.name} — ${one.why}`)
  }
}

function renderSettings (rows) {
  const width = Math.max(...rows.map(row => row.key.length))
  for (const { key, value, from } of rows) {
    const shown = Array.isArray(value) ? (value.length ? value.join(', ') : '(none)') : (value ?? '—')
    const note = from === 'set' ? '' : from === 'default' ? '  (default)' : from === 'unset' ? '  (not set)' : `  (${from})`
    console.log(`${key.padEnd(width)}  ${shown}${note}`)
  }
}

function renderConfig (value) {
  const entries = Object.entries(value)
  if (!entries.length) {
    console.log('nothing configured')
    return
  }
  for (const [key, held] of entries) {
    if (Array.isArray(held)) {
      console.log(`${key}:`)
      for (const item of held) console.log(`  ${item}`)
      if (!held.length) console.log('  (none)')
    } else if (key === 'plugins') {
      console.log(`${key}:`)
      for (const [name, allowed] of Object.entries(held)) console.log(`  ${name} ${allowed.version}`)
    } else if (typeof held === 'object' && held !== null) {
      console.log(`${key}:`)
      for (const [name, place] of Object.entries(held)) console.log(`  ${name} → ${place}`)
    } else console.log(`${key}: ${held}`)
  }
}

const stateText = (row) => {
  if (row.foreign) return `not spore's — ${row.foreign}`
  if (row.none) return row.none
  if (!row.defined) return 'not defined'
  return `${row.active} (${row.sub}) · ${row.enabled ? 'enabled' : 'disabled'}${row.pid ? ` · pid ${row.pid}` : ''}${row.since ? ` · since ${row.since}` : ''}`
}

function renderServices (result) {
  for (const row of result.services) {
    const width = Math.max(10, ...result.services.map(one => one.name.length))
    console.log(`  ${row.name.padEnd(width)} ${stateText(row)}`)
    console.log(`  ${''.padEnd(width)} ${row.what}`)
    for (const gone of row.stale ?? []) console.log(`  ${''.padEnd(width)} ${gone} is gone — spore service define ${row.name}`)
    if (row.outdated) console.log(`  ${''.padEnd(width)} running ${row.outdated.from} ${row.outdated.running}, ${row.outdated.installed} is installed — spore service restart ${row.name}`)
    if (row.unitChanged) console.log(`  ${''.padEnd(width)} pid ${row.pid} runs what the unit named before it was last written — spore service restart ${row.name}`)
  }
  for (const { plugin, problem } of result.problems) console.log(`  plugin ${plugin} offers no service: ${problem}`)
  console.log(result.linger
    ? '\n  lingering is on: services keep running after you log out'
    : '\n  lingering is off: services stop when you log out — loginctl enable-linger to keep them')
  const behind = result.services.filter(row => row.outdated).length
  if (behind) console.log(`  ${behind === 1 ? '1 service runs' : `${behind} services run`} older code than is installed — spore service restart --outdated`)
}

function renderService (row) {
  console.log(`${row.name} — ${row.what}`)
  console.log(`  ${stateText(row)}`)
  for (const gone of row.stale ?? []) console.log(`  ${gone} is gone — spore service define ${row.name}`)
  if (row.outdated) console.log(`  running ${row.outdated.from} ${row.outdated.running}, ${row.outdated.installed} is installed — spore service restart ${row.name}`)
  for (const unit of row.units ?? []) console.log(`  unit ${unit}`)
  if (row.log) console.log(`\n${row.log}`)
}

async function service (argv, emit) {
  const [, sub, name] = argv._
  const services = createServices()
  if (!sub || sub === 'ls') return emit(services.list(), renderServices)
  if (sub === 'restart' && argv.outdated && !name) {
    return emit(services.restartOutdated(), (restarted) => {
      if (!restarted.length) console.log('every service runs what is installed')
      for (const r of restarted) console.log(`restarted ${r.unit} — ${r.was} → ${r.now}, ${stateText({ ...r, defined: true })}`)
    })
  }
  if (!name) {
    console.error(`spore: service ${sub} needs a service — spore service ${sub} <svc>, from spore service ls${sub === 'restart' ? ', or --outdated for every one running older code than is installed' : ''}`)
    return 2
  }
  if (sub === 'show') return emit(services.show(name), renderService)
  if (sub === 'define') {
    return emit(services.define(name), (r) => {
      for (const unit of r.units) console.log(`wrote ${unit}`)
      console.log(`spore service start ${name} starts it; spore service enable ${name} starts it at every login`)
      if (r.next) console.log(`then: ${r.next}`)
    })
  }
  if (['start', 'stop', 'restart', 'enable', 'disable'].includes(sub)) {
    return emit(services.act(sub, name), (r) => { console.log(`${r.verb} ${r.unit} — ${stateText({ ...r, defined: true })}`) })
  }
  if (sub === 'rm') {
    return emit(services.remove(name, { yes: argv.yes }), (r) => { for (const unit of r.units) console.log(`removed ${unit}`) })
  }
  if (sub === 'log') {
    const lines = argv.n ?? argv.lines ?? '50'
    if (!/^\d+$/.test(lines)) {
      console.error(`spore: -n ${lines} is not a number of lines`)
      return 2
    }
    const unit = services.log(name)
    return spawnSync('journalctl', ['--user', '-u', unit, '-n', lines, '--no-pager', '-o', 'short-iso', ...(argv.f ? ['-f'] : [])], { stdio: 'inherit' }).status ?? 1
  }
  console.error(`spore: service has no "${sub}" — ls, show, define, start, stop, restart, enable, disable, log, rm`)
  return 2
}

function renderPlugins (result) {
  if (!result.plugins.length && !result.missing.length) {
    console.log(`no plugins installed beside spore — ${result.roots.join(', ') || 'no node_modules found'}`)
    return
  }
  for (const p of result.plugins.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${(p.allowed ? 'allowed' : 'installed').padEnd(STATE_WIDTH)} ${p.name.padEnd(12)} ${p.package}${p.version ? ` ${p.version}` : ''}`)
    if (p.problem) console.log(`  ${''.padEnd(STATE_WIDTH)} ${''.padEnd(12)} ${p.problem}`)
  }
  for (const name of result.missing) console.log(`  ${'missing'.padEnd(STATE_WIDTH)} ${name.padEnd(12)} allowed, and not installed beside spore`)
}

function renderPlugin (result) {
  const line = (label, value) => console.log(`  ${label.padEnd(10)} ${value}`)
  console.log(`${result.name} — ${result.package} ${result.version}  ${result.dir}`)
  line('state', result.allowed ? 'allowed' : 'installed, not allowed')
  line('works', `with @rhizogrip/spore ${result.works}`)
  for (const [i, [key, kind]] of Object.entries(result.settings).entries()) {
    line(i ? '' : 'settings', `${key} (${kind})${result.configured?.[key] === undefined ? '' : ` = ${result.configured[key]}`}`)
  }
  for (const [i, [name, path]] of Object.entries(result.programs).entries()) line(i ? '' : 'programs', `${name} → ${path}`)
  for (const [i, [name, value]] of Object.entries(result.env).entries()) line(i ? '' : 'env', `${name}=${value}`)
  if (result.contain) line('contain', result.contain.keep ? `${result.contain.keep}, and nothing else of ${result.contain.hide}` : `nothing of ${result.contain.hide}`)
  if (result.modules.length) line('modules', `${result.modules.join(', ')} → node_modules/, for the agent's programs`)
  if (result.sources.length) line('sources', `${result.sources.join(', ')} — granted with the plugin, held by the runner`)
  if (result.reference) line('reference', `${result.reference} → plugins/${result.name}.md`)
  if (result.precursors.length) line('precursors', result.precursors.join(', '))
  for (const [i, dir] of result.reads.entries()) line(i ? '' : 'reads', dir)
  if (result.services.length) line('services', `${result.services.join(', ')} — spore service ls`)
}

function plugin (argv, emit) {
  const [, sub, name, ...pairs] = argv._
  if (!sub || sub === 'ls') return emit(listPlugins(), renderPlugins)
  if (!['show', 'allow', 'disallow'].includes(sub)) {
    console.error(`spore: plugin has no "${sub}" — ls, show, allow, disallow`)
    return 2
  }
  if (!name) {
    console.error(`spore: plugin ${sub} needs a plugin — spore plugin ${sub} <plugin>${sub === 'allow' ? ' [k=v …]' : ''}`)
    return 2
  }
  if (sub === 'show') return emit(showPlugin(name), renderPlugin)
  if (sub === 'disallow') return emit(disallowPlugin(name), (r) => { console.log(`disallowed ${r.name} — a spore whose spore.cmk still names it is refused at its next send`) })
  return emit(allowPlugin(name, pairs), (r) => { renderPlugin(r); console.log(`\nallowed — a spore uses it once its spore.cmk says plugins: [${r.name}]`) })
}

function config (argv, emit) {
  const [, sub, key, value] = argv._
  if (key === 'model' && sub === 'get') {
    return emit(defaultModel(), (r) => { console.log(r.model ?? `none yet — spore config set model <provider>/<name> writes it into ${r.path}`) })
  }
  if (key === 'model' && sub === 'set' && value !== undefined) {
    return emit(setDefaultModel(value), (r) => { console.log(`model: ${r.model} — new spores are cut with it, from ${r.path}`) })
  }
  if (!sub || sub === 'get') {
    if (key !== undefined) getKey(key)
    const model = defaultModel()
    const rows = settings().concat({ key: 'model', value: model.model, from: model.model ? model.path : 'unset' })
    return emit(key === undefined ? rows : rows.filter(row => row.key === key), renderSettings)
  }
  if (sub === 'path') return emit({ file: CONFIG_FILE }, (v) => { console.log(v.file) })
  if (sub === 'set') {
    if (key === undefined || value === undefined) {
      console.error('spore: config set needs a key and a value')
      return 2
    }
    return emit(setKey(key, value), renderConfig)
  }
  if (sub === 'add') {
    if (key === undefined || value === undefined) {
      console.error('spore: config add needs a key and a value')
      return 2
    }
    return emit(addTo(key, value), renderConfig)
  }
  if (sub === 'rm') {
    if (key === undefined) {
      console.error('spore: config rm needs a key, and a value to drop just one of a list')
      return 2
    }
    return emit(removeFrom(key, value), renderConfig)
  }
  console.error(`spore: config has no "${sub}" — get, set, add, rm, path`)
  return 2
}

const USAGE_AXES = ['day', 'spore', 'origin', 'model', 'outcome', 'precursor']
const BAR_WIDTH = 24
const EIGHTHS = ' ▏▎▍▌▋▊▉'

const dollars = (micros) => `$${(micros / 1e6).toFixed(4)}`
const count = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))

function historyLine (history) {
  const cache = history.cacheShare === null ? '' : ` · cache ${Math.round(history.cacheShare * 100)}% over ${plural(history.rounds ?? 0, 'round')}`
  const over = history.over ? ' — OVER ITS BOUND, it was not summarized' : ''
  return `${count(history.sent)} / ${count(history.bound)} at turn ${history.turnNo}${cache}${over}`
}
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`

const bar = (micros, most) => {
  const eighths = most ? Math.round(micros / most * BAR_WIDTH * 8) : 0
  return ('█'.repeat(Math.floor(eighths / 8)) + (eighths % 8 ? EIGHTHS[eighths % 8] : '')).padEnd(BAR_WIDTH)
}

const NULL_KEYS = { model: 'unrecorded', outcome: 'unrecorded', precursor: '(the turns)' }

const keyText = (axis, row) => {
  if (row.key === null) return NULL_KEYS[axis]
  if (axis === 'model' && row.unmetered) return `${row.key}  not metered (${billingFor(row.key).label})`
  return row.key
}

function renderUsageTable (axis, rows, total) {
  const keys = rows.map(row => keyText(axis, row))
  const width = Math.max(axis.length, ...keys.map(key => key.length))
  console.log(`  ${axis.padEnd(width)}  turns  cells       spend  share`)
  for (const [i, row] of rows.entries()) {
    const share = total ? `${Math.round(row.micros / total * 100)}%` : ''
    console.log(`  ${keys[i].padEnd(width)}  ${String(row.turns).padStart(5)}  ${String(row.cells).padStart(5)}  ${dollars(row.micros).padStart(10)}  ${share.padStart(5)}`)
  }
}

function renderUsage (result, by) {
  const { window, totals, unsettled } = result
  const notes = [
    totals.unmetered ? `${plural(totals.unmetered, 'turn')} not metered` : null,
    unsettled.turns ? `${plural(unsettled.turns, 'turn')} unsettled, not summed` : null
  ].filter(Boolean)
  console.log([result.ws ? basename(result.ws) : 'every spore', `${window.since} – ${window.until} ${window.tz}`, dollars(totals.micros), ...notes].join(' · '))
  const limited = result.spend ? spendText(result.spend) : null
  if (limited) console.log(`your spores have spent ${limited}`)
  if (!totals.turns && !totals.cells) {
    console.log('\nnothing ran in this window')
    return
  }
  if (!by || by === 'day') {
    const most = Math.max(...result.days.map(day => day.micros))
    console.log('')
    for (const day of result.days) {
      const label = new Date(Date.parse(day.day)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
      const ran = day.turns || day.cells
        ? `${plural(day.turns, 'turn')}${day.cells ? ` + ${plural(day.cells, 'cell')}` : ''}   ${count(day.inputTokens)} in · ${count(day.outputTokens)} out · ${count(day.cacheReadTokens)} cache read`
        : ''
      console.log(`  ${label.padEnd(6)}  ${bar(day.micros, most)}  ${dollars(day.micros).padStart(10)}   ${ran}`.trimEnd())
    }
  }
  const axes = by ? [by].filter(axis => axis !== 'day') : USAGE_AXES.slice(1)
  for (const axis of axes) {
    const rows = result.by[axis]
    if (!by && axis === 'spore' && result.ws) continue
    if (!by && axis === 'precursor' && rows.every(row => row.key === null)) continue
    console.log('')
    renderUsageTable(axis, rows, totals.micros)
  }
}

export async function manage (verb, argv) {
  const emit = (value, render, exit = () => 0) => {
    if (argv.json) console.log(JSON.stringify(value, null, 2))
    else render(value)
    return exit(value)
  }

  try {
    if (verb === 'config') return config(argv, emit)
    if (verb === 'plugin') return plugin(argv, emit)
    if (verb === 'hook') return hook(argv, emit)
    if (verb === 'remake') {
      const name = argv._[1]
      if (!name) {
        console.error('spore: remake needs a spore — spore remake <name>')
        return 2
      }
      return emit(remake({ ws: name }), (r) => {
        console.error(`spore: made ${r.ws} again from the sporangium ${r.sporangium}, keeping ${r.moved.join(', ')}\n` +
          `       its database, trail and inbox are in ${r.aside} — remove that once you have looked`)
        console.log(r.ws)
      })
    }
    if (verb === 'upgrade') {
      const name = argv._[1]
      if (!name && !argv.all) {
        console.error('spore: upgrade needs a spore, or --all — spore upgrade <name>')
        return 2
      }
      return emit(upgrade({ ws: name, all: argv.all }), (r) => {
        for (const one of r.upgraded) console.log(`${one.ws}  ${one.replaced.length ? `replaced ${one.replaced.join(', ')}` : 'current'}`)
      })
    }
    if (verb === 'service') return await service(argv, emit)
    if (verb === 'doctor') {
      return emit(await diagnose(), renderDoctor, (report) => (report.findings.some(found => found.severity === 'problem') ? 1 : 0))
    }
    if (verb === 'define') {
      // No default to the current directory, unlike the read verbs: those answer about
      // where you are, and this one makes something. A bare `define` in a directory that
      // happens to hold a spore.cmk reported that it was already defined, which is an
      // answer to a question nobody asked.
      const name = argv._[1]
      if (!name) {
        console.error('spore: define needs a name — spore define <name>, or . for the directory you are in')
        return 2
      }
      return emit(define({ ws: name, definition: argv.definition, from: argv.from, sporangium: argv.sporangium, model: argv.model, plugins: [].concat(argv.plugin ?? []).map(String) }), renderDefine)
    }
    if (verb === 'log') return emit(log({ ws: argv._[1] }), renderLog)
    if (verb === 'sql') {
      const [, name, ...words] = argv._.map(String)
      const piped = words.length === 1 && words[0] === '-'
      const query = piped ? await readStdin() : words.join(' ')
      if (piped && !query.trim()) {
        console.error('spore: sql - read an empty query from stdin')
        return 2
      }
      const { lines } = sql({ ws: name, query: query || undefined, json: Boolean(argv.json) })
      for (const line of lines) console.log(line)
      return 0
    }
    if (verb === 'tick') return emit(tick(), renderTick, (result) => tickReport(result).exit)
    if (verb === 'pause') return emit(pause({ why: argv._.slice(1).join(' ') || undefined }), renderPause)
    if (verb === 'unpause') return emit(unpause(), renderUnpause, unpauseExit)
    if (verb === 'edit') return emit(await edit({ ws: argv._[1], open: openInEditor, again: editAgain }), renderEdit, editExit)
    if (verb === 'model') {
      const [, ws, model] = argv._.map(String)
      if (model) return emit(switchModel({ ws, model }), renderSwitch)
      const shown = show({ ws })
      return emit({ ws: shown.ws, model: shown.model, models: shown.models }, renderModels)
    }
    if (verb === 'extend') {
      const [, ws, dimension, amount] = argv._.map(String)
      if (!ws || !dimension || !amount) {
        console.error('spore: extend needs a spore, a limit and an amount — spore extend <name> wall 30m|cost 1.50|rounds 20')
        return 2
      }
      return emit(extend({ ws, dimension, amount }), renderChange, changeExit)
    }
    if (verb === 'wrap') {
      const [, ws, wait] = argv._.map(String)
      if (!ws) {
        console.error('spore: wrap needs a spore — spore wrap <name> [10m]')
        return 2
      }
      return emit(wrap({ ws, wait }), renderChange, changeExit)
    }
    if (verb === 'annotate') {
      const [, ws, ...words] = argv._.map(String)
      const text = argv.clear ? null : words.join(' ')
      if (!ws || (argv.clear ? words.length : !text.trim())) {
        console.error('spore: annotate needs a spore and a line, or --clear — spore annotate <name> <line>|--clear')
        return 2
      }
      return emit(annotate({ ws, text }), renderAnnotation(text), changeExit)
    }
    if (verb === 'job') {
      const [, sub, ws, name] = argv._
      if (!sub || sub === 'ls') return emit(jobs({ ws }), renderJobs)
      if (sub !== 'stop' || !ws || !name) {
        console.error('spore: job has ls and stop — spore job ls [<name>], spore job stop <name> <job>')
        return 2
      }
      let stopped
      try {
        stopped = stopJob({ ws, name })
      } catch (err) {
        if (err.type !== 'JOB_NOT_RUNNING') throw err
        console.error(`spore: ${err.message} — ${err.detail}`)
        return 1
      }
      return emit(stopped, (r) => { console.log(`asked the supervisor of ${r.name} (pid ${r.pid}) to stop it — how it ended is said to the spore`) })
    }
    if (verb === 'schedule') {
      const [, sub, ws, name, from] = argv._
      if (!sub || sub === 'ls') return emit(schedules({ ws }), renderSchedules)
      if (sub !== 'set' && sub !== 'rm') {
        console.error(`spore: schedule has no "${sub}" — set, rm, ls`)
        return 2
      }
      if (!ws || !name) {
        console.error(`spore: schedule ${sub} needs a spore and a schedule — spore schedule ${sub} <name> <sched>${sub === 'set' ? ' [<file>|-]' : ''}`)
        return 2
      }
      if (sub === 'rm') {
        return emit(removeSchedule({ ws, name }), (r) => { console.log(`removed ${r.name} — ${r.path}`) })
      }
      const source = !from || from === '-' ? await readStdin() : readFileSync(resolve(from), 'utf8')
      return emit(setSchedule({ ws, name, source }), (r) => { console.log(`scheduled ${r.name} — ${r.path}`) })
    }
    if (verb === 'approval') {
      const [, sub = 'ls', ws, from] = argv._
      if (sub !== 'ask' && sub !== 'ls') {
        console.error(`spore: approval has no "${sub}" — ask, ls`)
        return 2
      }
      if (!ws) {
        console.error(`spore: approval ${sub} needs a spore — ${sub === 'ask' ? 'spore approval ask <name> [<request.json>|-]' : 'spore approval ls <name>'}`)
        return 2
      }
      if (sub === 'ls') return emit(listApprovals({ ws }), renderApprovals)
      const source = !from || from === '-' ? await readStdin() : readFileSync(resolve(from), 'utf8')
      let request
      try {
        request = JSON.parse(source)
      } catch (err) {
        console.error(`spore: the request is not JSON — ${err.message}`)
        return 2
      }
      return emit(requestApproval({ ws, request }), (r) => { console.log(`asked ${r.approval}, open until ${when(r.until)} — the service of the place it names posts it`) })
    }
    if (verb === 'rm') {
      const name = argv._[1]
      if (!name) {
        console.error('spore: rm needs a spore — spore rm <name> [--yes]')
        return 2
      }
      return emit(remove({ ws: name, yes: argv.yes }), (r) => {
        console.log(`removed ${r.ws} — ${r.turns} turn(s), $${r.treeUsd.toFixed(4)}, ${size(r.bytes)}`)
      })
    }
    if (verb === 'usage') {
      if (argv.by !== undefined && !USAGE_AXES.includes(argv.by)) {
        console.error(`spore: usage --by is one of ${USAGE_AXES.join(', ')}`)
        return 2
      }
      return emit(usage({ ws: argv._[1], days: argv.days, since: argv.since, until: argv.until, tz: argv.tz }), (r) => renderUsage(r, argv.by))
    }
    if (verb === 'ls') return emit(list({ where: argv._[1], disk: true }), renderList, listExit)
    if (verb === 'show') return emit(show({ ws: argv._[1] }), renderShow)
    if (verb === 'precursor') {
      const sub = argv._[1]
      if (sub && sub !== 'ls') {
        console.error(`spore: precursor has no "${sub}" — only ls`)
        return 2
      }
      return emit(precursors({ ws: argv._[2] }), (result) => {
        for (const name of result.precursors) console.log(name)
        if (!result.precursors.length) console.log('none — this workspace delegates to nothing')
      })
    }
  } catch (err) {
    console.error(`spore: ${err.detail ? `${err.message} — ${err.detail}` : err.message}`)
    return 2
  }
}
