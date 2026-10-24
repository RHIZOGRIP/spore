import { dirname } from 'node:path'

import { loadEnvironment, recordStarted } from '../index.js'
import { botNames, botPath, botsDir, credentialOf, reactionsOf, routesOf } from './bot-file.js'
import { createRelay } from './relay.js'
import { statePath } from './state.js'

const REFUSED = 2

/**
 * A connector's service, `<program> <bot> [--check]`, run by `spore service` as `<kind>@<bot>`:
 * the bot file and its credentials read, `open` proving them against the platform and answering
 * the live adapter, then the relay until a signal. A refusal is exit 2, with the line to fix,
 * since systemd does not restart after it; `--check` stops once everything has been proved.
 *
 * `spec.hint(err, { file, bot })` is the platform's line to fix for an error, or null — and for a
 * bot file that is not there, the relay's own when the platform has none; `spec.refusals` the error
 * types that mean the platform will not have this bot at all.
 */
export async function runService ({ spec, program, root, open }) {
  const log = (line) => console.error(`${new Date().toISOString()} ${line}`)
  const refuse = (err, hint) => {
    console.error(`${program}: ${err.message}`)
    if (err.detail) console.error(`  ${err.detail}`)
    if (hint) console.error(`  ${hint}`)
    process.exit(REFUSED)
  }

  const bot = process.argv.slice(2).find(arg => !arg.startsWith('--'))
  if (!bot) {
    const here = botNames(spec)
    refuse(new Error('which bot?'), `${program} <bot> runs ${botsDir(spec)}/<bot>.json${here.length ? ` — here: ${here.join(', ')}` : ''}`)
  }

  const launched = { ...process.env }
  try {
    loadEnvironment()
  } catch (err) {
    refuse(err)
  }

  let file
  let opened
  const hint = (err) => spec.hint(err, { file, bot }) ??
    (err.type === `${spec.kind.toUpperCase()}_NO_BOT` ? `mkdir -p ${dirname(file)} — then ${file} as ${spec.example}` : null)
  try {
    file = botPath(spec, bot)
    routesOf(spec, file)
    if (spec.can.react) reactionsOf(spec, file)
    const credentials = Object.fromEntries(spec.credentials.map(field => [field, credentialOf(spec, file, field, process.env)]))
    opened = await open({ bot, file, credentials })
  } catch (err) {
    refuse(err, hint(err))
  }

  const state = statePath(spec.kind, bot)
  let relay
  try {
    relay = createRelay({ adapter: opened.adapter, botFile: file, statePath: state, env: launched, log })
  } catch (err) {
    refuse(err)
  }

  if (process.argv.includes('--check')) {
    console.log(`${program} ${bot} · ${opened.who} · ${file} · state ${state} · ready`)
    process.exit(0)
  }

  const controller = new AbortController()
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => controller.abort())

  recordStarted(`${spec.kind}@${bot}`, { root })
  log(`${program} ${bot} · ${opened.who} · ${file} · state ${state}`)
  try {
    await relay.run(controller.signal)
  } catch (err) {
    if (spec.refusals.includes(err.type)) refuse(err, hint(err))
    log(`stopped — ${said(err)}`)
    process.exit(1)
  }
  log('stopped')
  process.exit(0)
}

const said = (err) => [err.message, err.detail].filter(Boolean).join(' — ')
