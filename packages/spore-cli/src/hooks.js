import { durationText, listHooks, showHook } from '@rhizogrip/spore'

import { createServices } from './services.js'

const JOURNAL_LINES = 20
const ANSWER_CHARS = 120
const UNAVAILABLE = new Set(['SERVICE_NO_SYSTEMD', 'SERVICE_NOT_DEFINED'])

const kb = (bytes) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`

const verifyText = ({ method, header }) => header ? `${method} on ${header}` : method

const acceptText = (accept) => [
  accept.header ? `${accept.header} in ${accept.values.join(', ')}` : null,
  accept.payload ? 'payload schema' : null
].filter(Boolean).join(' · ')

const judgedBy = (spore) => [spore.router && 'router', spore.triage && 'triage'].filter(Boolean).join(' + ')

function sporeLine (spore, width) {
  const head = `→ ${spore.name.padEnd(width)}`
  if (!spore.ws) return `${head} no such spore`
  return [
    `${head} ${spore.count} delivered${spore.last ? `, last ${spore.last}` : ''}`,
    spore.held.length ? `${spore.held.length} held` : null,
    spore.accept ? `accepts ${acceptText(spore.accept)}` : null,
    judgedBy(spore) || null
  ].filter(Boolean).join(' · ')
}

function renderHooks ({ file, hooks }) {
  if (!hooks.length) {
    console.log(`${file} names no hook`)
    return
  }
  console.log(`${file} — deliveries over the last 7 days\n`)
  const width = Math.max(...hooks.map(hook => hook.name.length))
  for (const hook of hooks) {
    console.log(`  ${hook.name.padEnd(width)}  ${hook.path} · ${verifyText(hook.verify)}${hook.accept ? ` · accepts ${acceptText(hook.accept)}` : ''}`)
    const sporeWidth = Math.max(...hook.spores.map(spore => spore.name.length))
    for (const spore of hook.spores) console.log(`  ${''.padEnd(width)}  ${sporeLine(spore, sporeWidth)}`)
  }
}

function renderHook (hook) {
  console.log(`${hook.name} — ${hook.path}`)
  console.log(`  verify   ${verifyText(hook.verify)}`)
  if (hook.accept) console.log(`  accepts  ${acceptText(hook.accept)}`)
  console.log(`  bounds   ${kb(hook.maxBytes)} a request · ${hook.perHour} turns an hour · ${hook.maxWait ? `waits up to ${durationText(hook.maxWait)} · ${hook.perDay} triage cells a day` : 'released at once'}`)
  if (hook.owner) {
    const { plugin, name, timeoutMs, attach, reads } = hook.owner
    console.log(`  router   ${plugin}/${name}, the owner's: attaches up to ${attach.files} files and ${kb(attach.bytes)} within ${durationText(timeoutMs)}${reads === 'spore' ? ', reading what the spore\'s reads: grant' : reads.length ? `, reading ${reads.join(', ')}` : ''}`)
  }
  for (const spore of hook.spores) {
    console.log(`\n${sporeLine(spore, spore.name.length)}`)
    if (!spore.ws) continue
    if (spore.router) console.log(`  router   ${spore.router}${hook.owner ? ', not run: the owner\'s router is' : ''}`)
    if (spore.triage) console.log(`  triage   ${spore.triage}`)
    for (const held of spore.held) console.log(`  held     since ${held.at}, released ${held.releaseAt}, at the latest ${held.deadline}${held.summary ? ` — ${held.summary}` : ''}`)
    for (const d of spore.deliveries) {
      const fate = d.turnNo ? `turn ${d.turnNo} ${d.stopReason ?? 'running'}` : d.consumed ? 'read' : 'waiting'
      console.log(`  ${d.at}  ${[d.event, d.delivery].filter(Boolean).join(' ')}  ${fate}`)
    }
    for (const cell of spore.cells) {
      console.log(`  triage   ${cell.at}  ${cell.ref ?? ''}  ${cell.error ? `failed — ${cell.error}` : cell.answer.slice(0, ANSWER_CHARS)}  $${cell.costUsd.toFixed(4)}`)
    }
  }
  console.log(hook.journal === null ? `\nno journal: ${hook.journalWhy}` : `\n${hook.journal || 'the webhook service logged nothing about it'}`)
}

const journalOf = (services, name) => {
  try {
    const pattern = `^(hook ${name.replaceAll('.', '\\.')} |\\S+ /hook/${name.replaceAll('.', '\\.')}[/? ])`
    return { journal: services.journal('webhook', { grep: pattern, lines: JOURNAL_LINES }), journalWhy: null }
  } catch (err) {
    if (!UNAVAILABLE.has(err.type)) throw err
    return { journal: null, journalWhy: err.message }
  }
}

export function hook (argv, emit, { services = createServices } = {}) {
  const [, sub, name] = argv._.map(String)
  if (!sub || sub === 'ls') return emit(listHooks(), renderHooks)
  if (sub !== 'show') {
    console.error(`spore: hook has no "${sub}" — ls, show`)
    return 2
  }
  if (!name) {
    console.error('spore: hook show needs a hook — spore hook show <hook>, from spore hook ls')
    return 2
  }
  return emit({ ...showHook(name), ...journalOf(services(), name) }, renderHook)
}
