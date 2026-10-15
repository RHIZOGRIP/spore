/**
 * Saying something to a spore, and starting a turn if none is running.
 *
 * The command is argument parsing over this: it has no privileges and no knowledge the
 * library lacks.
 * Anything that drives a spore — a TUI, a relay, an embedder — needs exactly this, and
 * the lock race below is the reason it must not be reimplemented per consumer.
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { closeSync, openSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { takeSlot } from './admission.js'
import { preparePlugins, upgradeDocs } from './plugins.js'
import { enqueue, ERR_FILE, heldIn, inboxRequest, OUT_FILE, PLUGIN_ENV, releaseHeld } from './spore-dir.js'
import { RUNNING, stateOf } from './state.js'
import { bytesOf, containing, followingDocs, MEMORY_FILE, readConfig, SOURCES_FILE, spendLimits } from '../library/config.js'

const RUNNER = resolve(dirname(fileURLToPath(import.meta.url)), '../../native/spore-runner')
// mohdel's session program, resolved the way Node resolves the package this runs with.
export const SESSION = createRequire(import.meta.url).resolve('mohdel/session/bin')
export const CHATGPT_HELPER = createRequire(import.meta.url).resolve('mohdel/chatgpt/bin')

/**
 * Said first, started second. The inbox is the only channel, so a message delivered to a
 * spore that is already running needs no second path and one that starts a turn needs no
 * special case: whoever takes the lock reads what is there.
 *
 * Two callers racing both append and both try to start; one takes the `flock` and the
 * other exits without complaint, because its message was already delivered.
 *
 * A turn that would start needs an admission slot first, and with none free it is
 * refused before anything is said. A message to a turn already running needs none; if that
 * turn's runner lets go between the look and the append, this starts one, and every slot
 * taken at that moment is refused with the message already said.
 *
 * `attach` is how a file reaches a spore: `[{ name, mime, data }]`, written into
 * `<ws>/inbox.d/` and named in the entry. It goes through here rather than through each
 * consumer for the reason the lock race does — one naming rule, and one decision about
 * when a body stops being inline. `schedule` is the clock's `{ name, due }` and `hook` a
 * webhook's `{ name, event, delivery }`, each recorded on the entry; `from` is a person's `{ name,
 * id, where }`, which the turn reads above what they said; `traceparent` is the sender's trace
 * context, which the turn answering it is traced under.
 *
 * `inbox` is the message's `inboxNo`: the turn whose record's `inboxTo` first reaches it is
 * the one that answered it.
 *
 * `start: false` says the message and starts nothing: a turn running reads it at its next round,
 * and with none running it waits for the next turn something else starts. The webhook service
 * says a delivery so once a hook has started its hourly share of turns.
 *
 * `requestId` makes sending again safe for a sender that may lose track — a relay restarting
 * over updates it already passed on: the message is taken once, and `repeated` says this was
 * the second time. One a finished turn has already read starts nothing, since there is nothing
 * left to answer; one still waiting is started as any message is, in case whoever sent it first
 * died before the runner did.
 *
 * @returns {{ ws: string, started: boolean, pid: number|null, inbox: number, repeated: boolean }}
 */
export function send (ws, message, { attach = [], schedule, hook, from, traceparent, requestId, replyTo, start: starting = true, unsafe = false, debug = false, env = process.env } = {}) {
  const workspace = resolve(ws)
  const known = requestId === undefined ? null : inboxRequest(workspace, requestId)
  if (known?.consumed) return { ws: workspace, started: false, pid: null, inbox: known.inboxNo, repeated: true }
  if (!starting) return { ws: workspace, started: false, pid: null, ...enqueue(workspace, message, { attach, schedule, hook, from, traceparent, requestId, replyTo }) }
  // The slot is released on every path out, a failed append included: a caller that lives
  // on — a TUI, a relay — would otherwise hold it until it exits.
  const holding = (slot, then) => {
    try {
      return then()
    } finally {
      closeSync(slot.fd)
    }
  }
  const start = (slot, plugins, { inbox, repeated }) => {
    try {
      return { ws: workspace, started: true, pid: startRunner(workspace, { slot, plugins, unsafe, debug, env }), inbox, repeated }
    } catch (err) {
      err.detail = `${err.detail ?? err.message} — the message is in the inbox, and the next turn reads it`
      throw err
    }
  }

  if (stateOf(workspace).state !== RUNNING) {
    const plugins = preparePlugins(workspace)
    const slot = takeSlot()
    return holding(slot, () => start(slot, plugins, enqueue(workspace, message, { attach, schedule, hook, from, traceparent, requestId, replyTo })))
  }

  const said = enqueue(workspace, message, { attach, schedule, hook, from, traceparent, requestId, replyTo })
  // Looked at again after appending, because the runner may have let go in between. It
  // looks at the inbox again after it lets go, so a message is read by it or finds the
  // lock free here — never neither.
  if (stateOf(workspace).state === RUNNING) return { ws: workspace, started: false, pid: null, ...said }
  let plugins
  let slot
  try {
    plugins = preparePlugins(workspace)
    slot = takeSlot()
  } catch (err) {
    err.detail = `${err.detail} — the message is in the inbox, and the next turn reads it`
    throw err
  }
  return holding(slot, () => start(slot, plugins, said))
}

/**
 * What is held and due, moved into the inbox, and a turn started to read it — through the lock
 * race `send` uses, holding a slot before anything moves, so every slot taken leaves it held for the
 * next pass. While a turn runs, only what is past its deadline moves, and it joins that turn —
 * looked at again after, as `send` does, so a runner letting go in between leaves none unread.
 *
 * @returns {{ ws: string, released: number[], started: boolean }}
 */
export function release (ws, { now = Date.now(), env = process.env } = {}) {
  const workspace = resolve(ws)
  const at = new Date(now).toISOString()
  if (stateOf(workspace).state === RUNNING) {
    const released = releaseHeld(workspace, at, { due: false })
    if (!released.length || stateOf(workspace).state === RUNNING) return { ws: workspace, released, started: false }
    const plugins = preparePlugins(workspace)
    const slot = takeSlot()
    try {
      return { ws: workspace, released, started: true, pid: startRunner(workspace, { slot, plugins, env }) }
    } finally {
      closeSync(slot.fd)
    }
  }
  if (!heldIn(workspace).some(row => row.releaseAt <= at || row.deadline <= at)) return { ws: workspace, released: [], started: false }
  const plugins = preparePlugins(workspace)
  const slot = takeSlot()
  try {
    const released = releaseHeld(workspace, at, { due: true })
    return { ws: workspace, released, started: true, pid: startRunner(workspace, { slot, plugins, env }) }
  } finally {
    closeSync(slot.fd)
  }
}

/**
 * The runner, detached with its streams in the workspace, so the turn outlives whoever
 * asked for it and anything watching can pick the files up later. `continuing` starts it on
 * a turn a fork carried on rather than on the inbox.
 *
 * The slot goes to it as fd 3 and is held by the runner alone, which marks it
 * close-on-exec so the agent it starts does not inherit it. It starts the agent with the
 * Node this process runs on, and is told where the host describes its sources and what the
 * spore's plugins add to its agent's environment.
 */
export function startRunner (workspace, { slot, plugins, unsafe = false, debug = false, continuing = false, dream = false, env = process.env }) {
  const config = readConfig()
  if (followingDocs(config)) upgradeDocs(workspace, { config })
  const largestFile = bytesOf(config, 'largestFile')
  const freeFloor = bytesOf(config, 'freeFloor')
  const spend = spendLimits(config)
  const modelSessions = config.modelSessions ?? null
  const replyTo = config.replyTo?.[basename(workspace)] ?? null
  const out = openSync(resolve(workspace, OUT_FILE), 'a')
  const err = openSync(resolve(workspace, ERR_FILE), 'a')
  try {
    const runner = spawn(RUNNER, [
      '--ws', workspace,
      '--slot', slot.path,
      '--node', process.execPath,
      '--session', SESSION,
      '--chatgpt-helper', CHATGPT_HELPER,
      '--sources', resolve(dirname(config.file), SOURCES_FILE),
      '--memory', resolve(dirname(config.file), MEMORY_FILE),
      ...(Object.keys(plugins.sources).length ? ['--plugin-sources', JSON.stringify(plugins.sources)] : []),
      ...(plugins.contain.length ? ['--contain-keep', JSON.stringify(plugins.contain)] : []),
      ...(largestFile === null ? [] : ['--largest-file', String(largestFile)]),
      ...(freeFloor === null ? [] : ['--free-floor', String(freeFloor)]),
      ...(spend.day === null ? [] : ['--spend-per-day', String(spend.day)]),
      ...(spend.month === null ? [] : ['--spend-per-month', String(spend.month)]),
      ...(containing(config) ? [] : ['--no-contain']),
      ...(modelSessions === null ? [] : ['--model-sessions', String(modelSessions)]),
      ...(config.gate ? ['--gate', config.gate] : []),
      ...(replyTo === null ? [] : ['--reply-to', replyTo]),
      ...(unsafe ? ['--unsafe'] : []),
      ...(debug ? ['--debug'] : []),
      ...(continuing ? ['--continue'] : []),
      ...(dream ? ['--dream'] : [])
    ], { detached: true, stdio: ['ignore', out, err, slot.fd], env: Object.keys(plugins.env).length ? { ...env, [PLUGIN_ENV]: JSON.stringify(plugins.env) } : env })
    runner.unref()
    return runner.pid
  } finally {
    closeSync(out)
    closeSync(err)
  }
}

/**
 * The spore's dream started, through the lock race a turn uses, and refused as a turn is while the
 * spores are paused, past a spend limit, or with every slot taken. Its runner looks again under the
 * lock: a dream started a moment too late runs the turn that came first, or nothing.
 *
 * @returns {{ ws: string, started: boolean, pid?: number }}
 */
export function startDream (ws, { env = process.env } = {}) {
  const workspace = resolve(ws)
  if (stateOf(workspace).state === RUNNING) return { ws: workspace, started: false }
  const plugins = preparePlugins(workspace)
  const slot = takeSlot()
  try {
    return { ws: workspace, started: true, pid: startRunner(workspace, { slot, plugins, env, dream: true }) }
  } finally {
    closeSync(slot.fd)
  }
}
