import { sanitizeTranscript, computeBudget } from '../resilience/transcript.js'
import { createLoopGuard } from '../resilience/loop-guard.js'
import { compactIfNeeded, estimateTokens } from '../resilience/context-guard.js'
import { markConversationForCaching } from './prompt-cache.js'
import { REFUSED, WRAP, mark, marked } from './marks.js'
import { refusedResult } from './refusal.js'
import { withRecovery } from '../resilience/recovery.js'
import { executeTools } from './tool-kernel.js'
import { textOf } from './message.js'
import { MAX_EMPTY_RETRIES, accountUsage, resolveEmptyCompletion } from './answer-result.js'
import { silent } from '../observability/logger.js'
import { SporeError } from '../observability/errors.js'

const noEmit = { emit () {}, on () {}, has: () => false }

/**
 * The transcript as it goes out, with the conversation opted into prefix caching.
 *
 * `composeSystem` opens one breakpoint, on the system prompt — about 1,450 tokens — and
 * nothing opened one on the history, so a conversation was re-sent at full price on
 * every round however long it grew. mohdel takes the opt-in from a `cache` marker on any
 * message part and places the breakpoints itself, trailing plus a milestone every
 * sixteen blocks, so one marker is the whole signal.
 *
 * Marked on a copy. The marker turns a string `content` into an array of blocks, and the
 * live transcript has to stay strings: `estimateTokens` reads `content.length`, so a
 * marked message would weigh one token rather than its own size and every budget
 * downstream would be computed against it.
 */
function forCaching (messages, ttl) {
  if (!ttl || messages.length < 2) return messages
  const outgoing = messages.map(m => ({ ...m }))
  markConversationForCaching(outgoing, ttl)
  return outgoing
}

const LIMIT_TEXT = {
  rounds: (n) => `${n} rounds`,
  cost: (n) => `$${n.toFixed(4)}`,
  wall: (ms) => `${Math.round(ms / 1000)}s`
}

const HEARTBEAT_INTERVAL_MS = 10_000

// Every bound on what a turn carries is checked against an estimate before the provider has
// counted anything, so an estimate that reads well under what was counted is a bound that does
// not hold. Past a quarter under, and by more than a few thousand tokens, it is said once a turn.
const DRIFT_RATIO = 1.25
const DRIFT_FLOOR = 2_000

/**
 * Core tool loop — calls model, executes tools, repeats until done.
 *
 * @param {object} opts
 * @param {object} opts.model      — mohdel model proxy (has .answer())
 * @param {string} opts.system     — system prompt
 * @param {string} opts.prompt     — user prompt
 * @param {Array}  opts.tools      — tool definitions (mohdel format)
 * @param {object} opts.toolFns    — { name: async (args) => string }
 * @param {Function} [opts.describe] — (name, args) => { title, category, detail }, carried on `tool_start`
 * @param {object} opts.limits — {rounds,cost,wall} soft/hard pairs, declared in a .cmk, never here
 * @param {Map<string, {stopReason: string, says: boolean}>} [opts.terminalTools] — tools that end the turn
 * @param {object} [opts.emitter]  — event emitter for harness
 * @param {object} [opts.logger]
 * @returns {{ output: string|null, messages: Array, rounds: number, usage: object }}
 */
export async function loop ({ model, system, prompt, tools, toolFns, describe, limits, ledger, emitter = noEmit, mutators, terminalTools, signal, logger = silent, onMessage, sessionMemory, recall, now, interject, relimited, initialMessages, parentSpan, cacheTtl, reasoning = [], from }) {
  const userMsg = { role: 'user', content: prompt }
  if (!Number.isInteger(limits?.rounds?.soft) || !Number.isInteger(limits?.rounds?.hard)) {
    throw new Error('loop needs limits.rounds — declared in a .cmk, not defaulted here')
  }
  // `from` continues a turn that stopped between rounds: its history already ends on the
  // round's tool results, nothing new was said, and the rounds it took still count.
  const continuing = from !== undefined
  const messages = continuing ? [...initialMessages] : initialMessages?.length ? [...initialMessages, userMsg] : [userMsg]
  if (onMessage) {
    if (initialMessages?.length) for (const m of initialMessages) onMessage(m)
    if (!continuing) onMessage(userMsg)
  }
  // Recall is shown to the model and never written down. It reaches the model attached to
  // the turn that triggered it, but nobody said it — and the transcript is what long-term
  // memory indexes, so a recalled line persisted as user speech comes back as evidence of
  // itself. Measured before this: a note recalled, then deleted, then recalled again from
  // the record it had written itself into, twice over, with no source left alive.
  //
  // So the message on disk is the one the caller passed, and the copy in the array — the
  // one that is sent, every round — carries the recall in front of it. `now`, the time the turn
  // started, travels the same way: it changes every turn, so it goes behind everything a
  // provider caches, and nobody said it either.
  const shown = [now, recall ? `${recall}\n${prompt}` : prompt].filter(Boolean).join('\n\n')
  if ((recall || now) && !continuing) messages[messages.length - 1] = { ...userMsg, content: shown }
  const usage = { input: 0, output: 0, thinking: 0, cacheWrite: 0, cacheRead: 0, cost: 0 }
  const guard = createLoopGuard({ logger })
  const resilientModel = withRecovery(model, { messages, sessionMemory, logger, emitter, signal })
  const { contextLimit, maxResultSize } = computeBudget(model)
  let lastInputTokens = 0
  let drifted = false
  const emptyState = { retries: 0 }
  const emit = (event, data) => emitter.emit(event, data)
  const startedAt = Date.now()
  let wrapped = null
  let wrapAsked = false

  // Cost counts the whole tree. A cell's spend is not the parent's to ignore: it
  // was drawn from the same allowance, which is what makes the spore's ceiling a bound
  // on everything below it rather than on this loop alone.
  const spent = (round) => ({ rounds: round, cost: usage.cost + (ledger?.children || 0), wall: Date.now() - startedAt })

  // Soft is a warning the agent acts on; hard is a stop it has no say in. Cost is
  // only observable here because only a model call can raise it, so checking it
  // inside the loop is not a matter of trusting the loop.
  const crossed = (kind, at) => {
    for (const dim of ['rounds', 'cost', 'wall']) {
      const bound = limits[dim]?.[kind]
      if (bound !== undefined && at[dim] >= bound) return dim
    }
    return null
  }
  const append = (msg) => { messages.push(msg); if (onMessage) onMessage(msg) }

  // The first message of every call. A string or `composeSystem`'s blocks, each block a text
  // part keeping its `cache` marker — a breakpoint at that block.
  const systemMessage = {
    role: 'system',
    content: (Array.isArray(system) ? system : [{ text: system }])
      .map(block => (block.cache ? { type: 'text', text: block.text, cache: block.cache } : { type: 'text', text: block.text }))
  }

  // Wire streaming through emitter
  // Asked for by a listener, not by an emitter existing: every turn carries one now, so
  // that test would request deltas on every run and a brokered one refuses them.
  const streamHandler = emitter.has?.('stream')
    ? (chunk) => { if (chunk.delta) emitter.emit('stream', { kind: chunk.type, delta: chunk.delta }) }
    : null

  // A continued turn cut before its round's results: the calls the model asked for run now,
  // under the runtime as it is today, and the turn goes on from what they return.
  const unanswered = continuing && messages.at(-1)?.role === 'assistant' ? messages.at(-1).toolCalls || [] : []
  if (unanswered.length) {
    const toolResults = await executeTools({ toolCalls: unanswered, toolFns, describe, emitter, mutators, signal, logger })
    guard.record(toolResults)
    for (const tr of toolResults) append(tr)
  }

  for (let i = from ?? 0; ; i++) {
    if (signal?.aborted) {
      emitter.emit('complete', { output: null, usage, rounds: i, cancelled: true, stopReason: 'cancelled' })
      return { output: null, messages, rounds: i, usage, cancelled: true, stopReason: 'cancelled', spent: spent(i) }
    }

    const at = spent(i)
    const hard = crossed('hard', at)
    if (hard) {
      const stopReason = `hard:${hard}`
      logger.warn({ ...at, limit: limits[hard].hard, dimension: hard }, '[loop] hard limit — stopped')
      emitter.emit('complete', { output: null, usage, rounds: i, stopReason })
      return { output: null, messages, rounds: i, usage, stopReason, spent: at }
    }

    // Anything said to this spore since the last round. It lands as user speech because
    // a person said it — the reader decides what it means, which is why nothing here
    // looks for a keyword. `stop` is a message like any other, answered by wrapping up.
    for (const said of interject?.() || []) {
      logger.info({ round: i }, '[loop] a message arrived mid-turn')
      emit('interject', { round: i })
      append({ role: 'user', content: said })
    }

    // `limits` already holds the change; what the turn is told depends on what changed.
    for (const change of relimited?.() || []) {
      if (change.why === 'wrap') {
        wrapAsked = true
        continue
      }
      if (wrapped !== change.dimension) continue
      wrapped = null
      wrapAsked = false
      logger.info({ dimension: change.dimension, soft: change.soft, hard: change.hard }, '[loop] limit raised after wrapping')
      emit('unwrap', { dimension: change.dimension, soft: change.soft, hard: change.hard })
      append(mark({
        role: 'user',
        content: `[System: your owner raised this turn's ${change.dimension} limit — it now wraps at ${LIMIT_TEXT[change.dimension](change.soft)} and stops at ${LIMIT_TEXT[change.dimension](change.hard)}. Disregard the request to wrap up and carry on with the work.]`
      }, WRAP))
    }

    if (!wrapped) {
      const soft = crossed('soft', at)
      const stuck = soft ? null : guard.stalled()
      if (soft || stuck) {
        wrapped = soft || 'progress'
        const reached = soft ? `reached its ${soft} limit (${LIMIT_TEXT[soft](at[soft])})` : `stopped making progress — \`${stuck.tool}\` ${stuck.because}`
        const because = soft === 'wall' && wrapAsked ? 'been asked by its owner to wrap up' : reached
        logger.info({ ...at, dimension: wrapped }, '[loop] wrapping')
        emit('wrap', { dimension: wrapped, ...at, ...(stuck || {}) })
        append(mark({
          role: 'user',
          content: `[System: this turn has ${because}. Stop starting new work. Answer now with what you already have, and end by stating plainly what is unfinished and what a next turn should do. You have a little room to do that and no more.]`
        }, WRAP))
      }
    }

    emitter.emit('round', { index: i })
    sanitizeTranscript(messages, { maxResultSize, logger })
    if (contextLimit) compactIfNeeded(messages, { contextLimit, lastInputTokens, logger })

    const answerOpts = { tools }
    if (reasoning.includes('summaries')) answerOpts.reasoningSummaries = true
    if (reasoning.includes('raw')) answerOpts.rawReasoning = true
    // Without this the deadline and the user's cancel can only take effect between
    // rounds: a request already in flight runs to completion, and a hung one holds
    // the turn open indefinitely. It is also what makes the model broker's cancel
    // reachable, since that client acts on `options.signal`.
    if (signal) answerOpts.signal = signal
    if (parentSpan) answerOpts.parentSpan = parentSpan
    if (streamHandler) {
      answerOpts.realtimeHandler = streamHandler
      answerOpts.bufferOpts = { maxChars: 50, maxMs: 500 }
    }

    const callStartAt = Date.now()
    const heartbeatTimer = setInterval(() => {
      emitter.emit('heartbeat', { phase: 'answer', elapsedMs: Date.now() - callStartAt })
    }, HEARTBEAT_INTERVAL_MS)
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()
    let res
    try {
      res = await resilientModel.answer(() => [systemMessage, ...forCaching(messages, cacheTtl)], answerOpts)
    } catch (err) {
      // A model that honours the signal rejects. That rejection used to escape the
      // loop and `runSpore` alike, so the turn record — written after the loop
      // returns — was never reached: a cancelled or deadlined run left no stop
      // reason, no cost, and a workspace that looked like it had never run.
      if (!signal?.aborted) throw err
      logger.info({ rounds: i }, '[loop] cancelled mid-call')
      emitter.emit('complete', { output: null, usage, rounds: i, cancelled: true, stopReason: 'cancelled' })
      return { output: null, messages, rounds: i, usage, cancelled: true, stopReason: 'cancelled', spent: spent(i) }
    } finally {
      clearInterval(heartbeatTimer)
    }
    const elapsedMs = Date.now() - callStartAt
    lastInputTokens = accountUsage(res, { usage, emit, modelId: model?.id || 'unknown', elapsedMs })
    if (!drifted) {
      const estimated = estimateTokens([systemMessage, ...messages, { role: 'system', content: JSON.stringify(tools ?? []) }])
      if (lastInputTokens > estimated * DRIFT_RATIO && lastInputTokens - estimated > DRIFT_FLOOR) {
        drifted = true
        logger.warn({ round: i, estimated, sent: lastInputTokens, model: model?.id }, '[loop] the provider counted far more than the estimate — bounds on the history read low')
        emitter.emit('estimate_drift', { round: i, model: model?.id || 'unknown', estimated, sent: lastInputTokens })
      }
    }
    if (ledger) ledger.own = usage.cost

    if (res.status === 'incomplete') {
      throw new SporeError('the model stopped before finishing its reply', {
        type: 'MODEL_REPLY_INCOMPLETE',
        detail: `round ${i}${res.warning ? `: ${res.warning}` : ''}`
      })
    }
    const calling = res.status === 'tool_use'
    if (calling !== Boolean(res.toolCalls?.length)) {
      throw new SporeError('the model reply and its tool calls disagree', {
        type: 'MODEL_REPLY_INCONSISTENT',
        detail: `round ${i}: status ${res.status} with ${res.toolCalls?.length ?? 0} tool calls`
      })
    }

    if (calling) {
      const assistantMsg = { role: 'assistant', content: assistantContent(res), toolCalls: res.toolCalls }
      messages.push(assistantMsg)
      if (onMessage) onMessage(assistantMsg)

      // Observed, not filtered: the guard reports and the loop decides. What it
      // decides is the wrap above, on the next round.
      guard.observe(res.toolCalls)
      const allowed = res.toolCalls

      // A terminal tool ends the turn, so nothing after it in the batch may run.
      // The kernel schedules readers together and mutators after them, so batch
      // order is not execution order: `[ask, wsexec]` wrote the file and only then
      // returned the question — which matters most when the question is asking for
      // permission to do exactly that.
      const terminalAt = terminalTools ? allowed.findIndex(tc => terminalTools.has(tc.name)) : -1
      const running = terminalAt === -1 ? allowed : allowed.slice(0, terminalAt + 1)
      const shelved = terminalAt === -1 ? [] : allowed.slice(terminalAt + 1)

      const toolResults = await executeTools({
        toolCalls: running, toolFns, describe, emitter, mutators, signal, logger
      })
      guard.record(toolResults)
      for (const tr of toolResults) {
        messages.push(tr)
        if (onMessage) onMessage(tr)
      }
      // Answered rather than dropped: a tool call with no result leaves the
      // transcript malformed for the next turn that replays it.
      for (const tc of shelved) {
        emitter.emit('tool_block', { name: tc.name, reason: 'turn ended' })
        const skipped = refusedResult(tc.id, tc.name, `not run — "${allowed[terminalAt].name}" ended the turn before it. Ask again next turn if it is still what you want.`)
        messages.push(skipped)
        if (onMessage) onMessage(skipped)
      }

      // A stop during the batch wins over a terminal tool in it: readers run first, so a
      // `quiet` could have answered before the stop, and the turn did not end on its terms.
      if (signal?.aborted) {
        emitter.emit('complete', { output: null, usage, rounds: i + 1, cancelled: true, stopReason: 'cancelled' })
        return { output: null, messages, rounds: i + 1, usage, cancelled: true, stopReason: 'cancelled', spent: spent(i + 1) }
      }

      if (terminalAt !== -1) {
        const terminated = allowed[terminalAt]
        const { stopReason, says } = terminalTools.get(terminated.name)
        const terminalResult = toolResults.find(tr => tr.toolCallId === terminated.id)
        const text = terminalResult ? textOf(terminalResult) : null
        // A call the tool refused does not end the turn. Ending it on one would hand the
        // user an error message and, for a question, wait for them to answer it.
        if (!(terminalResult && marked(terminalResult, REFUSED))) {
          // `says` is whether the result is what the turn tells its user. A quiet turn's
          // result is its reason, which is for the record and must reach nobody as an answer.
          const ended = says ? { output: text } : { output: null, because: text }
          emitter.emit('complete', { ...ended, usage, rounds: i + 1, terminal: true, stopReason })
          return { ...ended, messages, rounds: i + 1, usage, terminal: true, stopReason }
        }
      }

      continue
    }

    // A reply that only told the person what it is about to do is not the answer: it goes back
    // as said, and the model goes on, within the bound an empty reply has.
    if (!res.output && res.commentaryParts?.length && emptyState.retries < MAX_EMPTY_RETRIES) {
      emptyState.retries++
      logger.info({ round: i, retry: emptyState.retries }, '[loop] commentary without an answer — going on')
      append({ role: 'assistant', content: assistantContent(res) })
      continue
    }

    // Degenerate completion (no tool call, no text): nudge for a real answer
    // (bounded) instead of returning empty.
    if (resolveEmptyCompletion(res, { emptyState, emit, append, logger, round: i })) continue

    const output = res.output || null
    const stopReason = wrapped ? `soft:${wrapped}` : 'answer'
    emitter.emit('complete', { output, usage, rounds: i + 1, stopReason })
    return { output, messages, rounds: i + 1, usage, stopReason, spent: spent(i + 1) }
  }
}

// Roundtrip the model's reasoning for providers that need it: DeepSeek V4 rejects a round whose
// assistant message lacks its `reasoning_content`, and a model whose provider carries reasoning
// as encrypted parts (`reasoningParts`) re-plans from scratch every round without them. What it
// wrote for the person (`commentaryParts`) goes back with its phase, so it is never read as an
// answer. With none of these, a plain string keeps the message compact.
function assistantContent (res) {
  const text = res.output || ''
  const reasoning = [...(res.reasoningParts ?? []), ...(res.reasoning ? [{ type: 'reasoning', text: res.reasoning }] : [])]
  const commentary = res.commentaryParts ?? []
  if (!reasoning.length && !commentary.length) return text
  return [...reasoning, ...commentary, ...(text || !commentary.length ? [{ type: 'text', text }] : [])]
}
