#!/usr/bin/env node
/**
 * The confined half of `spore`: applies the sandbox, runs the agent, and reports.
 * Started by the runner, which stays outside to hold the provider keys and host
 * the model broker — the agent reaches a model only through that socket.
 *
 * Everything user-facing happens here, because this is the process that has the
 * answer: stdout carries it, stderr carries how the turn ended.
 */

import minimist from 'minimist'

import { openChannel, readModelKey, readTranscript } from '../src/core/spore-dir.js'
import { buildContinuation } from '../src/core/continuation.js'
import { readFork } from '../src/core/fork.js'
import { PLUGIN_READS } from '../src/core/plugins.js'
import { openWorkspace } from '../src/core/workspace.js'
import { createModelClient } from '../src/infra/model-client.js'
import { autoLogger } from '../src/observability/logger.js'
import { ensureOtelInitialized, parseTraceparent, shutdownOtel } from '../src/observability/tracing.js'
import { runSpore } from '../src/core/spore-run.js'

const argv = minimist(process.argv.slice(2), { string: ['ws'], boolean: ['debug', 'unsafe', 'continue'] })

// The definition is read here rather than handed over: openWorkspace is what every
// entry point shares, and an environment variable is a poor way to carry an
// identity that is already on disk. The supervisor has installed any --definition already.
const opened = openWorkspace(argv.ws, { allowGranted: argv.unsafe })
if (opened.error) {
  console.error(`spore: ${opened.error}`)
  process.exit(2)
}

await ensureOtelInitialized()

const logger = autoLogger({ debug: Boolean(argv.debug) })

// Stopping this process is how a turn is cancelled from outside, and the abort is
// what reaches the rest of the tree: it kills each running tool's process group,
// and a cell dies with the shell that started it. Exiting on the signal instead
// would leave those running and the turn unrecorded.
const stopping = new AbortController()
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => stopping.abort())

let code = 1
try {
  const mo = await createModelClient({
    socketPath: process.env.SPORE_MODEL_SOCKET,
    modelIds: [opened.model, ...(opened.memory?.embedding ? [opened.memory.embedding] : [])],
    key: readModelKey(opened.ws),
    // This agent can spawn, so what its cells spend comes out of its allowance.
    tracksTree: true,
    logger
  })

  const result = await runSpore({
    identity: opened.identity,
    domainRules: opened.domainRules,
    workspace: opened.ws,
    modelIds: [opened.model],
    mo,
    // The runner's end of it holds the workspace's writer; this process never opens one.
    state: openChannel(Number(process.env.SPORE_STATE_FD)),
    // The supervisor's broker, which this process reaches over a socket and points its
    // cells at. It never builds one: it holds no key to authenticate against.
    modelSocket: process.env.SPORE_MODEL_SOCKET,
    storeSocket: process.env.SPORE_STORE_SOCKET,
    sourceSocket: process.env.SPORE_SOURCE_SOCKET,
    excludeTools: opened.excludeTools,
    reads: opened.reads,
    writes: opened.writes,
    pluginReads: process.env[PLUGIN_READS] === undefined ? [] : JSON.parse(process.env[PLUGIN_READS]),
    socketDir: process.env.SPORE_SOCKET_DIR,
    limits: opened.limits,
    // Long-term memory, when the definition asks for one. Absent means this workspace
    // keeps nothing beyond its transcript, which is the default.
    memory: opened.memory,
    // What it may look at, and how much of it, this turn. Absent means it cannot.
    images: opened.images,
    // Whether it may write its own schedules, and within what. Absent means they are its
    // operator's alone.
    schedules: opened.schedules,
    historyBudget: opened.history,
    dated: true,
    sandbox: !argv.unsafe,
    initialMessages: readTranscript(opened.ws),
    // A fork's turn goes on from its cut; `spore fork` is the only thing that asks for this.
    resume: argv.continue ? readFork(opened.ws) : null,
    parentSpan: parseTraceparent(process.env.TRACEPARENT),
    signal: stopping.signal,
    logger
  })

  if (result.output != null) process.stdout.write(result.output.endsWith('\n') ? result.output : result.output + '\n')

  if (result.stopReason === 'cancelled') {
    process.stderr.write(`spore: stopped after ${result.rounds} rounds — the turn is recorded and the workspace is intact\n`)
  }
  if (result.stopReason === 'quiet') {
    process.stderr.write(`spore: nothing to say — ${result.because}\n`)
  }
  if (result.stopReason === 'question') {
    process.stderr.write('spore: that is a question, not an answer — run spore again here with your reply\n')
  }
  if (result.stopReason?.startsWith('soft:')) {
    process.stderr.write(`spore: wrapped early — ${result.stopReason.slice(5)} limit reached; the answer above is what it had\n`)
  }
  if (result.stopReason?.startsWith('hard:')) {
    // No model call on this path: the thing that overran is what would answer.
    const { text, path } = buildContinuation(opened.ws, { stopReason: result.stopReason, spent: result.spent })
    process.stderr.write('\n' + text)
    if (path) process.stderr.write(`\nwritten to ${path}\n`)
  }

  code = result.output != null || result.stopReason === 'quiet' ? 0 : 1
} catch (err) {
  console.error(`spore: ${err.detail || err.message}`)
}

await shutdownOtel()
process.exit(code)
