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

import { withSlot } from './admission.js'
import { preparePlugins, upgradeDocs } from './plugins.js'
import { enqueue, ERR_FILE, heldIn, inboxRequest, OUT_FILE, PLUGIN_ENV, releaseHeld } from './spore-dir.js'
import { RUNNING, stateOf } from './state.js'
import { turnEnv } from './turn-env.js'
import { bytesOf, CONFIG_FILE, containing, followingDocs, MEMORY_FILE, readConfig, secondsOf, SOURCES_FILE } from '../library/config.js'

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
 * id, where, zone? }`, which the turn reads above what they said — `zone` the IANA zone of their
 * clock, where the platform says it, so the turn reads when they said it in their time; `traceparent` is the sender's trace
 * context, which the turn answering it is traced under.
 *
 * `inbox` is the message's `inboxNo`: the turn whose record's `inboxTo` first reaches it is
 * the one that answered it.
 *
 * `start: false` says the message and starts nothing: a turn running reads it at its next round,
 * and with none running it waits for the next turn something else starts.
 *
 * `approval` is the id of an approval this message tells of — a press of its buttons, or its
 * deadline passing — said by the relay of the conversation it was asked in, which `replyTo` names.
 *
 * `overheard: true` is a message said where the spore is and not to it — in a group, beside its
 * addressed messages. It starts nothing and is owed no answer, so it needs `from` and takes no
 * `replyTo`; whatever turn comes next reads it as what was said around it.
 *
 * `requestId` makes sending again safe for a sender that may lose track — a relay restarting
 * over updates it already passed on: the message is taken once, and `repeated` says this was
 * the second time. One a finished turn has already read starts nothing, since there is nothing
 * left to answer; one still waiting is started as any message is, in case whoever sent it first
 * died before the runner did.
 *
 * @returns {{ ws: string, started: boolean, pid: number|null, inbox: number, repeated: boolean }}
 */
export function send (ws, message, { attach = [], schedule, hook, from, traceparent, requestId, replyTo, overheard = false, approval, start: starting = true, debug = false, env = process.env, configFile = CONFIG_FILE } = {}) {
  const workspace = resolve(ws)
  const known = requestId === undefined ? null : inboxRequest(workspace, requestId)
  if (known?.consumed) return { ws: workspace, started: false, pid: null, inbox: known.inboxNo, repeated: true }
  if (overheard) return { ws: workspace, started: false, pid: null, ...enqueue(workspace, message, { attach, from, traceparent, requestId, replyTo, overheard }) }
  if (!starting) return { ws: workspace, started: false, pid: null, ...enqueue(workspace, message, { attach, schedule, hook, from, traceparent, requestId, replyTo, approval }) }
  const inInbox = (err) => {
    err.detail = `${err.detail ?? err.message} — the message is in the inbox, and the next turn reads it`
    return err
  }
  const start = (slot, plugins, { inbox, repeated }) =>
    ({ ws: workspace, started: true, pid: startRunner(workspace, { slot, plugins, debug, env, configFile }), inbox, repeated })

  if (stateOf(workspace).state !== RUNNING) {
    const plugins = preparePlugins(workspace, { config: readConfig(configFile) })
    return withSlot(slot => {
      const said = enqueue(workspace, message, { attach, schedule, hook, from, traceparent, requestId, replyTo, approval })
      try {
        return start(slot, plugins, said)
      } catch (err) {
        throw inInbox(err)
      }
    })
  }

  const said = enqueue(workspace, message, { attach, schedule, hook, from, traceparent, requestId, replyTo, approval })
  // Looked at again after appending, because the runner may have let go in between. It
  // looks at the inbox again after it lets go, so a message is read by it or finds the
  // lock free here — never neither.
  if (stateOf(workspace).state === RUNNING) return { ws: workspace, started: false, pid: null, ...said }
  try {
    const plugins = preparePlugins(workspace, { config: readConfig(configFile) })
    return withSlot(slot => start(slot, plugins, said))
  } catch (err) {
    throw inInbox(err)
  }
}

const startsNone = (row) => JSON.parse(row.entry).startsTurn === false

/**
 * What is held and due, moved into the inbox, and a turn started to read it — through the lock
 * race `send` uses, holding a slot before anything moves, so every slot taken leaves it held for the
 * next pass. While a turn runs, only what is past its deadline moves, and it joins that turn —
 * looked at again after, as `send` does, so a runner letting go in between leaves none unread.
 * What is due and was delivered past its origin's `perHour` moves without starting one.
 *
 * @returns {{ ws: string, released: number[], started: boolean }}
 */
export function release (ws, { now = Date.now(), env = process.env, configFile = CONFIG_FILE } = {}) {
  const workspace = resolve(ws)
  const at = new Date(now).toISOString()
  if (stateOf(workspace).state === RUNNING) {
    const late = heldIn(workspace).filter(row => row.deadline <= at)
    const released = releaseHeld(workspace, at, { due: false })
    if (!released.length || stateOf(workspace).state === RUNNING || late.every(startsNone)) return { ws: workspace, released, started: false }
    const plugins = preparePlugins(workspace, { config: readConfig(configFile) })
    return withSlot(slot => ({ ws: workspace, released, started: true, pid: startRunner(workspace, { slot, plugins, env, configFile }) }))
  }
  const due = heldIn(workspace).filter(row => row.releaseAt <= at || row.deadline <= at)
  if (!due.length) return { ws: workspace, released: [], started: false }
  if (due.every(startsNone)) return { ws: workspace, released: releaseHeld(workspace, at, { due: true }), started: false }
  const plugins = preparePlugins(workspace, { config: readConfig(configFile) })
  return withSlot(slot => {
    const released = releaseHeld(workspace, at, { due: true })
    return { ws: workspace, released, started: true, pid: startRunner(workspace, { slot, plugins, env, configFile }) }
  })
}

/**
 * The runner, detached with its streams in the workspace, so the turn outlives whoever
 * asked for it and anything watching can pick the files up later. `continuing` starts it on
 * a turn a fork carried on rather than on the inbox.
 *
 * The slot goes to it as fd 3 and is held by the runner alone, which marks it
 * close-on-exec so the agent it starts does not inherit it. It starts the agent with the
 * Node this process runs on, and is told where the host describes its sources and what the
 * spore's plugins add to its agent's environment. `env` and `configFile` are what the caller was
 * launched with; the runner gets `env` as `turnEnv` makes it from `configFile`.
 */
export function startRunner (workspace, { slot, plugins, debug = false, continuing = false, dream = false, env = process.env, configFile = CONFIG_FILE }) {
  const config = readConfig(configFile)
  if (followingDocs(config)) upgradeDocs(workspace, { config })
  const largestFile = bytesOf(config, 'largestFile')
  const freeFloor = bytesOf(config, 'freeFloor')
  const modelSessions = config.modelSessions ?? null
  const replyTo = config.replyTo?.[basename(workspace)] ?? null
  const environment = turnEnv(env, { configFile: config.file, sources: plugins.sources })
  if (Object.keys(plugins.env).length) environment[PLUGIN_ENV] = JSON.stringify(plugins.env)
  const out = openSync(resolve(workspace, OUT_FILE), 'a')
  const err = openSync(resolve(workspace, ERR_FILE), 'a')
  try {
    const runner = spawn(RUNNER, [
      '--ws', workspace,
      '--slot', slot.path,
      ...hostFlags(config, plugins.contain),
      '--sources', resolve(dirname(config.file), SOURCES_FILE),
      '--memory', resolve(dirname(config.file), MEMORY_FILE),
      ...(Object.keys(plugins.sources).length ? ['--plugin-sources', JSON.stringify(plugins.sources)] : []),
      ...(largestFile === null ? [] : ['--largest-file', String(largestFile)]),
      ...(freeFloor === null ? [] : ['--free-floor', String(freeFloor)]),
      ...(modelSessions === null ? [] : ['--model-sessions', String(modelSessions)]),
      ...(replyTo === null ? [] : ['--reply-to', replyTo]),
      ...(debug ? ['--debug'] : []),
      ...(continuing ? ['--continue'] : []),
      ...(dream ? ['--dream'] : [])
    ], { detached: true, stdio: ['ignore', out, err, slot.fd], env: environment })
    runner.unref()
    return runner.pid
  } finally {
    closeSync(out)
    closeSync(err)
  }
}

/**
 * The flags the runner and a cell outside any turn are both given by the host: the Node and the
 * mohdel helpers they run, whether to contain, what the spore's plugins keep in view of a contained
 * process, the gate, and when a model call is cut.
 */
export function hostFlags (config, keep) {
  const callCeiling = secondsOf(config, 'callCeiling')
  return [
    '--node', process.execPath,
    '--session', SESSION,
    '--chatgpt-helper', CHATGPT_HELPER,
    ...(containing(config) ? [] : ['--no-contain']),
    ...(keep.length ? ['--contain-keep', JSON.stringify(keep)] : []),
    ...(config.gate ? ['--gate', config.gate] : []),
    ...(callCeiling === null ? [] : ['--call-ceiling', String(callCeiling)])
  ]
}

/**
 * The spore's dream started, through the lock race a turn uses, and refused as a turn is while the
 * spores are paused or with every slot taken. Its runner looks again under the lock: a dream
 * started a moment too late runs the turn that came first, or nothing.
 *
 * @returns {{ ws: string, started: boolean, pid?: number }}
 */
export function startDream (ws, { env = process.env, configFile = CONFIG_FILE } = {}) {
  const workspace = resolve(ws)
  if (stateOf(workspace).state === RUNNING) return { ws: workspace, started: false }
  const plugins = preparePlugins(workspace, { config: readConfig(configFile) })
  return withSlot(slot => ({ ws: workspace, started: true, pid: startRunner(workspace, { slot, plugins, env, configFile, dream: true }) }))
}
