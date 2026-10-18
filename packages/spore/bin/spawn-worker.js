#!/usr/bin/env node
/**
 * The confined half of a spawn: applies the sandbox, runs the sub-agent, and
 * writes its answer. Started by native/spore-spawn, which stays outside to host the
 * enzyme broker — a broker inside the confinement could not reach the enzymes.
 */

import { ftruncateSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

import { TOOL_NAMES } from '../src/core/tool-names.js'
import { runSpore } from '../src/core/spore-run.js'
import { createModelClient } from '../src/infra/model-client.js'
import { enzymeRules } from '../src/delegation/enzyme-catalog.js'
import { buildContinuation } from '../src/core/continuation.js'
import { autoLogger } from '../src/observability/logger.js'
import { ensureOtelInitialized, parseTraceparent, shutdownOtel } from '../src/observability/tracing.js'
import { SporeError, toWireError } from '../src/observability/errors.js'
import { SPAWN_FILE, openChannel, readModelKey } from '../src/core/spore-dir.js'
import { linkGrants, superGrants } from '../src/core/workspace.js'

const plan = JSON.parse(process.env.SPORE_PLAN)
const logger = autoLogger({ debug: Boolean(process.env.SPORE_DEBUG) })
const started = Date.now()

// A subprocess inherits no TracerProvider, so without this every span here is the
// API's no-op and the cell is missing from the trace its parent is in. Returns at
// once when OTEL_EXPORTER_OTLP_ENDPOINT is unset, which is the usual case.
await ensureOtelInitialized()
const parentSpan = parseTraceparent(process.env.TRACEPARENT)

// The cell holds no provider key. Its model is a socket its parent listens on,
// which is what makes the cell's own cost limit something other than advice.
// Which model runs behind that socket is the precursor's to say; a precursor that
// names none inherits its parent's, which arrives as $MODEL from the spawning agent.
const modelIds = [plan.precursor.model || process.env.MODEL].filter(Boolean)
const mo = await createModelClient({ socketPath: process.env.SPORE_MODEL_SOCKET, modelIds, key: readModelKey(plan.ws), logger, precursor: plan.precursor.name, workspace: plan.ws })

// cwd is the parent's workspace — `spawn` is invoked through its `wsexec`, which
// runs there. A fan-out writes one of these lines per cell into a single log, so
// the frame has to say which cell it is about; the parent joins on this path.
const where = relative(process.cwd(), plan.ws)

// The frame goes to the workspace as well as to stdout, because detached there is
// no stdout: the supervisor that started us was launched with none. Opened before
// the sandbox, like the transcript, since the root is a read path by the time
// there is anything to write.
const frameFd = openSync(resolve(plan.ws, SPAWN_FILE), 'w')
const writeFrame = (frame) => {
  ftruncateSync(frameFd, 0)
  writeSync(frameFd, JSON.stringify(frame) + '\n', 0)
}
const report = (frame) => {
  writeFrame(frame)
  console.log(JSON.stringify(frame))
}

// Written before anything else runs: this file is what says the workspace is spent,
// and it has to say so from the moment a cell starts rather than when it finishes.
writeFrame({ precursor: plan.precursor.name, ws: where, startedAt: new Date(started).toISOString(), running: true })

// A stop is the turn's abort, as it is for the root: the cell kills its tools' process
// groups, writes its record and frame, and only then exits. Node's default would exit at
// once and leave those tools writing into a workspace whose lock is then let go.
const stopping = new AbortController()
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => stopping.abort())

// A cell reaches a corpus the way its parent does, and only the one its own precursor
// declares: the definition is the grant at either level, root or cell.
const reads = linkGrants(plan.ws, plan.precursor.reads).filter(r => !r.missing)

const granted = plan.superReach ? superGrants(plan.ws, plan.superReach) : null

try {
  if (granted?.spore.missing) throw new SporeError('the super cell cannot reach its spore', { type: 'SUPER_UNREACHABLE', detail: granted.spore.error ?? `${plan.superReach.spore} is gone` })
  const result = await runSpore({
    prompt: readFileSync(plan.promptPath, 'utf8'),
    identity: plan.precursor.identity,
    domainRules: enzymeRules(plan.precursor.enzymes),
    workspace: plan.ws,
    modelIds,
    mo,
    // Written through `spore-spawn`, which holds the cell's database as a runner holds a root's.
    state: openChannel(Number(process.env.SPORE_STATE_FD)),
    // The parent's broker, reached over a socket. A cell holds no key of its own and
    // hosts nothing; the cell supervisor is what refuses a spawn from inside one.
    modelSocket: process.env.SPORE_MODEL_SOCKET,
    sourceSocket: process.env.SPORE_SOURCE_SOCKET,
    reads: granted ? [...reads, ...granted.reads] : reads,
    writes: granted ? granted.writes : [],
    excludeTools: TOOL_NAMES.filter(name => !plan.precursor.tools.includes(name)),
    limits: plan.precursor.limits,
    images: plan.precursor.images,
    reasoning: plan.precursor.reasoning,
    sandbox: true,
    parentSpan,
    signal: stopping.signal,
    logger
  })

  // An answer the cell wrapped up rather than finished is only an answer if the
  // precursor says so. Left in place it is indistinguishable from a complete one
  // to the program that reduces fifty of these.
  const wrapped = Boolean(result.stopReason?.startsWith('soft:'))
  const answered = result.output != null && !(wrapped && plan.precursor.onWrap === 'discard')
  if (answered) {
    mkdirSync(dirname(plan.answerPath), { recursive: true })
    writeFileSync(plan.answerPath, result.output)
  }

  // Whatever the reason, a cell with no answer owes the parent the record instead.
  // Assembled from disk, so it costs no model call — see continuation.js.
  const continuation = answered
    ? null
    : buildContinuation(plan.ws, {
      stopReason: result.stopReason,
      spent: result.spent,
      precursor: plan.precursor.name
    }).path

  report({
    precursor: plan.precursor.name,
    ws: where,
    // What the cell actually ran against, so a result stays attributable to a
    // program after the file has moved on.
    ...(plan.precursor.enzymes.length ? { enzymes: Object.fromEntries(plan.precursor.enzymes.map(e => [e.name, e.hash])) } : {}),
    answer: answered ? plan.answer : null,
    stopReason: result.stopReason || null,
    continuation,
    rounds: result.rounds || 0,
    cost: Math.round((result.usage?.cost || 0) * 1000000) / 1000000,
    elapsedMs: Date.now() - started
  })
  await shutdownOtel()
  process.exit(answered ? 0 : 1)
} catch (err) {
  console.error(`spawn: ${err.detail || err.message}`)
  const failure = typeof err?.toJSON === 'function'
    ? err
    : new SporeError('the cell could not finish', { type: 'SPAWN_WORKER_FAILED', detail: err?.message })
  report({ precursor: plan.precursor.name, ws: where, answer: null, error: toWireError(failure) })
  await shutdownOtel()
  process.exit(1)
}
