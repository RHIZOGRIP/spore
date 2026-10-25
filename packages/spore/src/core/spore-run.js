/**
 * One turn of an agent, root or cell: the confined half of a supervisor and worker. The tools
 * are `makeTools`'s and a command's process is `runShell`'s; this reads the inbox, runs the
 * loop and hands the turn's outcome to its supervisor.
 */

import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { effectiveContextLimit } from 'mohdel'
import { sandbox } from '../isolation/sandbox.js'
import { silent } from '../observability/logger.js'
import { SporeError } from '../observability/errors.js'
import { startSpan, endSpanOk, endSpanError, formatTraceparent, serializeSpanContext } from '../observability/tracing.js'
import { createEmitter } from '../observability/emitter.js'
import { attachEventLog } from '../observability/event-log.js'
import { createLedger, micros, totalSpend, workUnits } from '../infra/ledger.js'
import { openStore } from '../memory/store.js'
import { recallBlock } from '../memory/recall.js'
import { maxResultSizeForContext } from '../resilience/transcript.js'
import { compactHistory, historyBound, historyOver } from '../resilience/compaction.js'
import { createSessionMemory } from '../resilience/session-memory.js'
import { makeTools, recordRefusals } from '../tools/make-tools.js'
import { loop } from './loop.js'
import { describeCall } from './call-table.js'
import { COMPACTED, marked } from './marks.js'
import { DATA_DIR, appendCompaction, linkTurnTmp, appendTranscript, fromPerson, inboxConsumed, readInbox, readInboxFrom, readModelKey, readSaidSoFar, runningLimits, writableDirs, writeOutcome } from './spore-dir.js'
import { dataBytesIn, deliverablesIn } from './deliverables.js'
import { scheduleDir } from './schedule.js'
import { composeSystem } from './system-prompt.js'
import { callsIn, createCallTrail } from './call-record.js'

// Last block before the conversation: the foundation is mostly method, and on a cold turn the
// model answers as the thing that prompt describes. Constant, like everything ahead of the
// conversation, which a provider caches as a prefix matched byte for byte.
const TURN_NOTE = 'This turn may be ordinary conversation. If it is, answer it as you would anything else — plainly, and without describing your tools or listing what you are able to do.'

const LIMITS_EVERY_MS = 2000

// Shown in front of the turn's own message rather than in the system prompt, where a value that
// changes would make the whole conversation after it uncacheable on every turn.
function nowLine (now = new Date()) {
  const day = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
  return `Now: ${now.toISOString().slice(0, 16)}Z (${day}). Compute dates and durations from this, never from assumption.`
}

/**
 * Run a spore agent.
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} opts.identity        — the definition's body: what the agent is told it is
 * @param {string} [opts.rules]         — what the agent can reach here, written by the runtime
 * @param {'5m'|'1h'} [opts.cacheTtl='5m']
 * @param {string} opts.workspace
 * @param {string} opts.modelId         — the model the turn runs on, as the definition's `model:`
 * @param {boolean} [opts.sandbox=false]
 * @param {object} [opts.logger]
 * @returns {{ output, messages, rounds, usage, stopReason, spent }}
 */
export async function runSpore ({
  // Absent in the spore: what to do arrives in the workspace's inbox, which is also where
  // anything said mid-turn lands. A cell is handed its prompt instead — it has no user
  // to hear from and its directory is used once.
  prompt,
  identity,
  rules,
  cacheTtl = '5m',
  // Long-term memory: `{ backend, push, pull }`, declared in the definition and absent by
  // default. Every number in it came from one sweep over one dataset, so none of them is
  // defaulted here — a number buried in the runtime is a number nobody benchmarks.
  memory = null,
  images = null,
  // `reasoning:` from the definition: what each model call asks for besides the answer.
  reasoning = [],
  // `schedules: [count, interval]` from the root definition: whether `schedules/` is the
  // agent's to write, and what bounds it.
  schedules = null,
  // `history:` from the root definition: tokens of earlier turns carried word for word.
  historyBudget = null,
  // `lastSent(ws)`: what the provider counted for the call before this turn, and on which model.
  lastSent = null,
  // A root turn is told when it started; a cell's prompt was written by a parent that knew.
  dated = false,
  // Whether the definition grants `dream`: only then is `data/` weighed for the turn record.
  dreams = false,
  workspace,
  modelId,
  // The model client, and it is required. This function is the confined half of a
  // supervisor and worker: the half that holds no key, reaches a model through
  // whatever it was handed, and does not decide how that was built.
  mo,
  // The turn's writer: the channel to its supervisor, which holds the workspace's only writer
  // connection. Required for the reason `mo` is — this half writes nothing of its own accord.
  state,
  // Where a cell reaches the model — the supervisor's to own, because it outlives this
  // turn. Absent means this agent has no children to point anywhere.
  modelSocket,
  storeSocket,
  sourceSocket,
  limits,
  sandbox: applySandbox = false,
  initialMessages,
  // The suite's tools the definition does not grant, taken off what the model is offered.
  excludeTools,
  // Corpora the definition declared, already linked into the workspace by `openWorkspace`.
  // Three layers have to agree for one of these to work, and this is where two of them
  // are told: the ruleset below, and the path check the tools go through.
  reads = [],
  // Directories the definition writes, linked in the same way. Granted read-write here; the
  // path check lets write and edit reach them, and exec still only reads them.
  writes = [],
  // What the sandbox reads of the plugins the definition uses, each plugin and the packages it
  // depends on. Only the ruleset needs them: the agent runs their programs, it does not read them.
  pluginReads = [],
  // How its calls are described to whoever watches the turn, before the runtime's own rows: its
  // definition's `:::call` blocks, then its plugins' `describe`.
  calls = [],
  // The spore's socket directory, its runner's: granted read-write so a cell it spawns can bind its
  // enzyme broker there, and the only place under `/tmp` it may write.
  socketDir = null,
  // A turn cut short at a round boundary by `spore fork`, carried on rather than begun:
  // `{ runId, rounds, inboxTo, startedAt }`. No message starts it and none is read, the
  // calls go on numbering in the same run, and the rounds it took still count.
  resume = null,
  parentSpan,
  signal,
  logger = silent
} = {}) {
  if (!modelId) {
    throw new SporeError('model not set', {
      type: 'MODEL_NOT_SET',
      detail: 'a definition says what it runs on, as model: <provider>/<name>; runSpore takes it as modelId'
    })
  }
  if (!mo) {
    throw new SporeError('model client not supplied', {
      type: 'MODEL_CLIENT_REQUIRED',
      detail: 'runSpore is the confined half of a supervisor and worker: the supervisor builds the model client and hosts the broker. Start it with `send`, or pass `mo`.'
    })
  }
  if (!identity) {
    throw new SporeError('identity not supplied', {
      type: 'IDENTITY_REQUIRED',
      detail: 'the identity is the body of the definition the turn runs under — parse the .cmk and pass its identity'
    })
  }
  if (!state) {
    throw new SporeError('state writer not supplied', {
      type: 'STATE_CHANNEL',
      detail: 'runSpore writes its records through the turn\'s channel to its supervisor. Start it with `send`, or pass `state`.'
    })
  }
  const WS = resolve(workspace)

  // Root of this spore's OTel subtree; one `runSpore()` call = one span.
  const sporeDispatchSpan = startSpan('spore.dispatch', {
    'spore.workspace': WS,
    'spore.model': modelId
  }, parentSpan)
  // Bound to this run's own span rather than to `parentSpan`, which an upstream may not
  // have passed: every line carries a trace either way.
  if (logger.child) logger = logger.child({ span: serializeSpanContext(sporeDispatchSpan) })

  logger.debug({ workspace: WS, cwd: process.cwd() }, '[spore] workspace')
  const systemBlocks = composeSystem({
    identity,
    rules,
    note: TURN_NOTE
  }, { cacheTtl })

  // Everything said to this spore that no turn has answered yet. How far it was read is
  // carried in the turn records rather than by clearing the inbox: the agent's workspace root
  // is read-only, so it can read the inbox and could never clear it.
  let inboxAt = resume ? resume.inboxTo : prompt !== undefined ? 0 : inboxConsumed(WS)
  const answeredTo = inboxAt
  let turnPrompt = prompt
  let person = resume ? readInbox(WS, { after: inboxConsumed(WS), upto: resume.inboxTo }).find(fromPerson) ?? null : null
  if (turnPrompt === undefined && !resume) {
    const said = readInboxFrom(WS, inboxAt)
    inboxAt = said.at
    person = said.person
    turnPrompt = said.messages.join('\n\n')
    if (!turnPrompt) {
      throw new SporeError('nothing to do', {
        type: 'NOTHING_SAID',
        detail: `no unanswered message in ${WS} — spore send <name> <message> puts one there`
      })
    }
  }

  // Read once a round rather than watched: a burst arrives as one message, and a turn
  // that is between model calls is the only moment it is safe to change what it is doing.
  const interject = () => {
    const said = readInboxFrom(WS, inboxAt)
    if (said.at !== inboxAt) events.emit('inbox_read', { inboxTo: said.at })
    inboxAt = said.at
    person ??= said.person
    return said.messages
  }

  logger.info({ model: modelId }, '[spore] loop started')

  // The root stays read-only so spore.cmk, lock and the transcript outlive the
  // agent; every directory it legitimately writes is granted back on top.
  // Landlock silently skips a rule for a path that does not exist, so every
  // island has to be on disk before the ruleset is built or it is never granted.
  const islands = [...writableDirs(WS), ...(schedules ? [scheduleDir(WS)] : [])]
  for (const dir of islands) mkdirSync(dir, { recursive: true })
  const trail = resume
    ? createCallTrail(WS, { runId: resume.runId, seq: callsIn(WS, resume.runId), round: resume.rounds, state })
    : createCallTrail(WS, { state })
  const trailRunId = trail.runId
  linkTurnTmp(WS, trail.root)
  const turnStartedAt = resume ? resume.startedAt : new Date().toISOString()
  if (applySandbox) sandbox(WS, { writeDir: DATA_DIR, extraWritePaths: [...islands, ...writes.map(w => w.path), socketDir], extraReadPaths: [...reads.map(r => r.path), ...pluginReads], logger })

  const model = mo.use(modelId)

  const contextLimit = effectiveContextLimit(model.info?.())
  // Only the spore carries a history; a cell is handed its prompt and used once.
  const carried = prompt === undefined ? historyBound(contextLimit, historyBudget) : null
  const maxOutput = maxResultSizeForContext(contextLimit)

  // Whoever keeps the books says so: a brokered client reports what the host has served.
  // None is built here beyond a count of its own — this half holds no keys and outlives nothing.
  const ledger = mo.ledger || createLedger()

  // What a turn did belongs to the workspace, so it is written to the log, and whoever
  // watches the turn reads it there.
  const events = createEmitter()
  const eventLog = attachEventLog(events, { state, runId: trailRunId, logger })
  events.on('round', ({ index }) => { trail.round = index + 1 })
  // What the provider counted for the turn's first call is the history it carried, measured
  // rather than estimated: what the turn record holds against the bound.
  let historySent = null
  if (carried !== null) events.on('usage', ({ input, cacheRead, cacheWrite }) => { historySent ??= input + cacheRead + cacheWrite })
  events.emit('inbox_read', { inboxTo: inboxAt })
  let { fns, defs } = makeTools(WS, maxOutput, trail, {
    modelId,
    traceparent: formatTraceparent(sporeDispatchSpan),
    modelSocket,
    storeSocket,
    sourceSocket,
    reads,
    writes,
    pluginReads,
    images,
    schedules,
    unanswered: () => person
  })
  if (Array.isArray(excludeTools) && excludeTools.length) {
    const excluded = new Set(excludeTools)
    defs = defs.filter(t => !excluded.has(t.name))
    for (const name of excluded) delete fns[name]
  }

  fns = recordRefusals(fns, trail)

  // One per turn. Facts are extracted from the messages an overflow drop mid-loop
  // takes, and handed back to the model in the notice that reports the loss.
  const sessionMemory = createSessionMemory({ logger })

  // The wall is the one bound the loop cannot police for itself: a round that hangs
  // inside a tool never reaches the next check. Started here rather than after the
  // setup below, because compaction is itself a model call that can block, and a
  // deadline that only begins once setup finishes is not a deadline on the turn.
  const wallStop = new AbortController()
  const onOuterAbort = () => wallStop.abort()
  // An outer signal already aborted fires no event, so the listener alone would
  // start a turn that was cancelled before it began.
  if (signal?.aborted) wallStop.abort()
  else signal?.addEventListener('abort', onOuterAbort, { once: true })
  // Which of the two aborted matters to the record: a deadline is `hard:wall`, a
  // caller stopping the turn is `cancelled`, and one controller cannot say.
  let wallHit = false
  const wallFrom = Date.now()
  let wallTimer = null
  const armWall = (hard) => {
    clearTimeout(wallTimer)
    wallTimer = setTimeout(() => {
      wallHit = true
      logger.warn({ wall: hard }, '[spore] hard wall limit — aborting')
      wallStop.abort()
    }, Math.max(0, hard - (Date.now() - wallFrom)))
  }
  if (limits?.wall?.hard) armWall(limits.wall.hard)

  // A root turn's limits can be changed by its owner while it runs; each change is a row the
  // runner wrote, read here between rounds and through any tool, so a raised wall is in force
  // before the old one would have fired. A wrap is a moment on the clock, written as an offset
  // from the turn's start, and the loop counts its wall from its own.
  const live = limits && Object.fromEntries(Object.entries(limits).map(([dimension, pair]) => [dimension, { ...pair }]))
  const relimits = []
  const seen = {}
  let loopFrom = null
  const follow = live && prompt === undefined
    ? setInterval(() => {
      let running
      try {
        running = runningLimits(WS)
      } catch (err) {
        logger.warn({ err: err.message }, '[spore] cannot read the turn\'s limits; a change waits for the next look')
        return
      }
      for (const [dimension, row] of Object.entries(running?.limits ?? {})) {
        if (row.why === 'start' || row.limitNo === seen[dimension] || !live[dimension]) continue
        seen[dimension] = row.limitNo
        const was = { ...live[dimension] }
        const soft = row.why === 'wrap' ? Math.max(0, Date.parse(running.startedAt) + row.soft - (loopFrom ?? wallFrom)) : row.soft
        live[dimension] = { soft, hard: row.hard }
        relimits.push({ dimension, why: row.why, soft, hard: row.hard, was })
        if (dimension === 'wall' && row.hard !== was.hard) armWall(row.hard)
      }
    }, LIMITS_EVERY_MS)
    : null

  // Inference this turn paid for that is not the loop's own: it is ours, so it
  // belongs in `cost`, and the broker already counted it as ours when subtracting.
  let setupCost = 0

  // Summarize a history that has outgrown its retention budget before replaying
  // it. Without this the entry point grows the transcript until `recovery` starts
  // dropping turn-groups outright, and the replay is most of what a long run pays
  // for. The entry recorded here is what `readTranscript` collapses against next
  // time, so the summarizing happens once.
  let history = initialMessages
  if (history?.length) {
    history = await compactHistory(history, {
      model,
      contextLimit,
      budget: historyBudget,
      sent: lastSent !== null && lastSent.model === model.id ? lastSent.tokens : null,
      signal: wallStop.signal,
      onCost: (cost) => { setupCost += cost },
      onCompacted: (entry) => {
        appendCompaction(state, entry)
        events.emit('compaction', { summaryChars: entry.summary.length, firstKeptIndex: entry.firstKeptIndex })
      },
      onStarted: (started) => events.emit('compaction_started', started),
      onFailed: (failure) => events.emit('compaction_failed', failure),
      logger
    })
  }

  // loop.js fires onMessage for every replayed initialMessage too, and those are
  // already on disk — without the skip a resumed run doubles its own transcript,
  // then quadruples it.
  let replayed = history?.length || 0
  const onMessage = (msg) => {
    if (replayed > 0) {
      replayed--
      return
    }
    appendTranscript(state, msg)
  }

  let recall = null
  let recalled = null
  try {
    // Long-term memory, if this definition has any. The store holds what the context no
    // longer does, so the horizon is where the live history begins: everything said before
    // it has been evicted and is the store's. A compaction summary stands in for messages
    // rather than being one, so it does not count towards what is still live.
    //
    // Recall goes in front of the turn's own text. It arrives with the thing that triggered
    // it, the way a taste brings back a room — the freshest part of the prompt, past every
    // cache breakpoint, and read before the question rather than after it.
    if (memory && !resume) {
      const live = (history || []).filter(message => !marked(message, COMPACTED)).length
      const store = openStore(WS, { ...memory, horizon: Math.max(0, readSaidSoFar(WS).length - live), socket: storeSocket, key: readModelKey(WS), mo, signal: wallStop.signal })
      try {
        const surfaced = await store.push(turnPrompt)
        // A note that cannot be read is worth saying out loud: recall carries on without it,
        // and the agent is the one who can go and fix it.
        for (const bad of store.unreadable) logger.warn({ note: bad.path, why: bad.why }, '[memory] unreadable')
        // Every score that reached the model, kept per turn. Recall has no notion of a weak
        // match — it takes whatever scored above zero, which in BM25 is any shared word —
        // and nothing has ever recorded how good the hits it surfaces actually are. Without
        // that distribution a relevance floor can only be guessed at, and a guessed number
        // is the thing the definition's own numbers exist to avoid.
        recalled = surfaced.map(hit => Math.round(hit.score * 1e4) / 1e4)
        if (surfaced.length) {
          events.emit('recall', { hits: surfaced.length, scores: recalled })
          logger.debug({ hits: surfaced.length, scores: recalled }, '[memory] surfaced')
          recall = recallBlock(surfaced)
        }
      } catch (err) {
        // BM25 cannot fail here; a remote backend can, and a rate limit or a cold service
        // is not a reason to lose the turn — it is answerable without recall. Emitted as
        // well as logged, so a run can report how often memory went unconsulted rather
        // than reading a degraded score as a worse mechanism. An aborted recall is not a
        // failure of memory: the loop that follows ends the turn as cancelled or as the wall.
        if (!wallStop.signal.aborted) {
          events.emit('recall', { hits: 0, failed: err.type || 'RECALL_FAILED' })
          logger.warn({ type: err.type, why: err.message, detail: err.detail }, '[memory] recall failed — answering without it')
        }
      }
    }

    loopFrom = Date.now()
    const result = await loop({
      interject,
      model,
      system: systemBlocks,
      prompt: turnPrompt,
      now: dated ? nowLine() : null,
      recall,
      tools: defs,
      toolFns: fns,
      describe: (name, args) => describeCall(name, args, calls),
      limits: live,
      relimited: () => relimits.splice(0),
      ledger,
      emitter: events,
      mutators: new Set(['write', 'edit', 'wsexec']),
      terminalTools: new Map([
        ['ask', { stopReason: 'question', says: true }],
        ['quiet', { stopReason: 'quiet', says: false }]
      ]),
      onMessage,
      sessionMemory,
      cacheTtl,
      reasoning,
      initialMessages: history,
      from: resume?.rounds,
      signal: wallStop.signal,
      logger,
      parentSpan: sporeDispatchSpan
    })

    // How this turn ended, where something outside the process can read it. The
    // stop reason is otherwise formatted for a human on stderr and lost, leaving
    // every reader — a parent reducing a fan-out, a batch, the next turn —
    // to infer it from structures that exist for other reasons.
    // A child that finished after our last response is invisible in a ledger that
    // only refreshes on one. Ask once, here, before the turn is written down.
    if (mo.spend) await mo.spend().catch(err => logger.warn({ err: err.message }, '[spore] cannot read what the cells spent; the runner settles the record from its own ledger'))
    if (result.stopReason === 'cancelled' && wallHit) result.stopReason = 'hard:wall'

    // What the turn hands back, read from `data/out/` rather than from the trail: a call
    // records the streams it redirected, never what a program wrote while it ran, and a
    // rendered report is exactly that case.
    if (historyOver(historySent, carried)) logger.warn({ sent: historySent, bound: carried }, '[spore] this turn carried more history than its bound')
    const { deliverables, more: deliverablesMore } = deliverablesIn(WS, turnStartedAt)
    events.emit('deliverables', { files: deliverables, more: deliverablesMore })

    writeOutcome(state, {
      runId: trailRunId,
      startedAt: turnStartedAt,
      endedAt: new Date().toISOString(),
      model: modelId,
      stopReason: result.stopReason || null,
      // Ended on its own terms: with an answer, a question, or nothing to say. A quiet turn
      // read and dealt with what it was sent, which is what the runner and `stateOf` ask.
      concluded: result.output != null || result.stopReason === 'quiet',
      ...(result.because != null ? { because: result.because } : {}),
      output: result.output,
      rounds: result.rounds || 0,
      ownMicros: micros((result.usage?.cost || 0) + setupCost),
      // What the turn drew on the allowance, cells included. `ownMicros` is this loop's
      // own, and anything adding up what a workspace has spent wants the total —
      // a fan-out's bill is almost all in the children.
      treeMicros: micros((result.usage?.cost || 0) + setupCost + (ledger.children || 0)),
      // What the turn cost in reasoning rather than money, its own rounds weighted 2:1 over its cells'.
      // Counted at the broker, so it includes retries and every cell's work — including
      // cells whose answers were discarded — and nothing the agent reports about itself.
      workUnits: workUnits(ledger),
      workUnitsOwn: ledger.ownRounds || 0,
      workUnitsChildren: ledger.childRounds || 0,
      // How far the inbox has been read. The next turn starts here, so a crash replays
      // nothing that was answered and loses nothing that was not.
      inboxTo: inboxAt,
      // Beside the answer rather than inside it: a consumer reads `{ output, deliverables }`
      // and never parses prose to find the file the turn made.
      deliverables,
      ...(deliverablesMore ? { deliverablesMore } : {}),
      dataBytes: dataBytesIn(WS, { dreams }),
      historySent,
      historyBound: carried,
      // The tokens behind that money. Cost alone cannot say why a turn was dear: a
      // prefix that missed the cache and one that hit it differ by an order of
      // magnitude and look identical in dollars. `cacheRead` on a resumed turn is the
      // one measurement that says caching is working — see ARCHITECTURE.md, "Prompt caching".
      inputTokens: result.usage?.input || 0,
      outputTokens: result.usage?.output || 0,
      thinkingTokens: result.usage?.thinking || 0,
      cacheWriteTokens: result.usage?.cacheWrite || 0,
      cacheReadTokens: result.usage?.cacheRead || 0,
      ...(recalled ? { recall: recalled } : {})
    })

    // loop.js returns the terminal answer as `output` and deliberately keeps it
    // out of `messages`, which is the next request's payload. A transcript owes
    // the reader the reply, so persist it here or every resume loses one. A
    // terminal tool is the exception: its result is already the last message on
    // disk, and echoing it would put the question in the transcript twice.
    if (result.output != null && !result.terminal) {
      onMessage({ role: 'assistant', content: result.output })
    }

    // `result.usage.cost` aggregates every model call this agent made, its cells not
    // folded in: `treeMicros` in the turn record is where they are.
    const sporeLoopCost = result.usage?.cost || 0

    endSpanOk(sporeDispatchSpan, {
      'spore.rounds': result.rounds || 0,
      'spore.input_tokens': result.usage?.input || 0,
      'spore.output_tokens': result.usage?.output || 0,
      'spore.cost': sporeLoopCost
    })

    logger.info({ rounds: result.rounds || 0, inputTokens: result.usage?.input || 0, outputTokens: result.usage?.output || 0, thinkingTokens: result.usage?.thinking || 0, cost: sporeLoopCost }, '[spore] loop done')
    return {
      ...result,
      cost: sporeLoopCost
    }
  } catch (err) {
    // A turn that died still happened. Without this the workspace says nothing at all —
    // the prompt on disk, no turn recorded, no calls — which is indistinguishable from
    // never having been started.
    const left = deliverablesIn(WS, turnStartedAt)
    writeOutcome(state, {
      runId: trailRunId,
      startedAt: turnStartedAt,
      endedAt: new Date().toISOString(),
      model: modelId,
      stopReason: 'error',
      error: err.type || err.name || 'ERROR',
      detail: err.detail || err.message,
      concluded: false,
      // Where this turn started reading: it answered nothing, so what it read is pending
      // for the next one.
      inboxTo: answeredTo,
      // Not zero. The loop threw without returning its usage, but the ledger is shared
      // with the broker and already holds what was actually served — a turn that did a
      // billable round and then hit a provider error was recording no spend, and every
      // spend report believed it.
      rounds: null,
      ownMicros: micros(totalSpend(ledger) - (ledger.children || 0) + setupCost),
      treeMicros: micros(totalSpend(ledger) + setupCost),
      // A turn that died can still have written what it meant to hand back.
      deliverables: left.deliverables,
      ...(left.more ? { deliverablesMore: left.more } : {}),
      dataBytes: dataBytesIn(WS, { dreams }),
      historySent,
      historyBound: carried
    })
    endSpanError(sporeDispatchSpan, err)
    throw err
  } finally {
    clearTimeout(wallTimer)
    clearInterval(follow)
    signal?.removeEventListener('abort', onOuterAbort)
    // A turn that died mid-answer still said what it had said so far.
    eventLog.flush()
  }
}
