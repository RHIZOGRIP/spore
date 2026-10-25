/**
 * Spore — an agent in a workspace, and many of them.
 *
 *   import { send, watch, list, show } from '@rhizogrip/spore'
 *
 * Everything the command can answer is here, because the command is argument parsing over
 * exactly these: anything driving a spore — a TUI, a relay, an embedder — needs the same
 * answers and must not reimplement them. The `send` lock race in particular is the reason
 * that rule matters: two implementations of it are two runners.
 *
 * `runSpore` is deliberately not here. It is the *confined half* of a pair, and a
 * caller that is not a supervisor gets no lock, no retention, no model broker, no
 * key and no confinement it can rely on — which is why it used to default to running
 * unsandboxed. `send` and `runBatch` get both halves and the process boundary between
 * them: every spore is started the same way the command starts one.
 */

import { createRequire } from 'node:module'
export const version = createRequire(import.meta.url)('../package.json').version

// Saying something to a spore, and following what it does about it.
export { release, send } from './core/send.js'
export { fork, forkWorkspace, readFork } from './core/fork.js'
export { watch, watchAll, turnsSince, outcome } from './library/watch.js'
export { follow } from './library/follow.js'
export { annotateTurn, applyEvent, createLive, liveIn, liveOf, renderLive } from './library/live.js'
export { describeCall } from './core/call-table.js'

// What exists, what one is, what it has done — the read verbs the `spore` command prints.
export { doctor, modelFindings } from './library/doctor.js'
export { listHooks, showHook } from './library/hooks.js'
export { answerApproval, callApprovalHook, inputsProblem } from './library/approvals.js'
export { annotate, define, defaultModel, switchModel, edit, extend, grantOf, jobs, list, listApprovals, log, pause, requestApproval, show, sporePaths, usage, precursors, remake, remove, schedules, setDefaultModel, setSchedule, removeSchedule, sporangia, sql, stopJob, unpause, upgrade, wrap, defaultSporangiumPath } from './library/verbs.js'
export { isWorkspace, workspacesIn } from './library/discover.js'
export { readConfig, followingDocs, loadEnvironment, workspaceFor, recordLayout, existing, getKey, setKey, addTo, removeFrom, settings, hereSnapshots, instancesDir, instanceFile, instanceNames, CONFIG_FILE, CONFIG_DIR, NAME, NAMES_A_PATH } from './library/config.js'
export { NAMES } from './core/names.js'
export { recordStarted, versionAt, SERVICE_STATE_DIR } from './library/service-record.js'
export { billingFor, unmetered } from './core/billing.js'
export { checkSqlite } from './core/sqlite.js'
export { DEFAULT_SPORANGIUM } from './core/sporangia.js'

// mohdel's readings of the models spores run on, its catalog's curation, and the `mo` installed with
// spore, so a setup runs it without `mo` on PATH and on the one mohdel spore pins.
export { loadDefaultEnv as loadMohdelEnvironment, modelReadiness, modelsOf, providerReadiness } from 'mohdel/readiness'
export { CLI as MO } from 'mohdel/cli'
export { curate, upstream } from 'mohdel/curate'

// What one is doing now, stopping it, and running many at once.
export { stateOf, stateWord, stop, RUNNING } from './core/state.js'
export { changeText, extendTurn, runningLines, wrapTurn } from './core/limits.js'
export { runBatch } from './core/batch.js'

// Plugins — `spore plugin` is argument parsing over these — and the docs a spore was given.
export { listPlugins, showPlugin, allowPlugin, disallowPlugin, differingDocs, pluginServices, pluginRoots } from './core/plugins.js'

// Turns the clock starts: one pass fires what is due, and a schedule is a file.
export { tick, tickReport, TICK_LOCK } from './core/tick.js'
export { paused } from './core/admission.js'
export { bytesText, durationSpelling, durationText, sizeSpelling } from './core/units.js'
export { parseSchedule, survey, SCHEDULE_DIR } from './core/schedule.js'

// What a definition says and what a spore can carry to another, read without running it.
export { parseDefinition, parseFrontmatter, PRECURSOR_DIR } from './delegation/definition.js'
export { TOOL_NAMES } from './core/tool-names.js'
export { cloneCapability } from './core/clone.js'
export { grantedPathContaining } from './isolation/sandbox.js'

// Reading a workspace without starting anything: what a turn said, how it ended,
// what remains of one that was stopped.
export { openWorkspace } from './core/workspace.js'
export { textOf } from './core/message.js'
export { readTranscript, readTurns, readEvents, readInbox, asked, saidOf, originLabel, lastEventSeq, databaseOf, definitionPath, heldIn, turnOfMessage, turnSummary, outbox, attemptOutbox, settleOutbox, setAside, approvalsIn, approvalOf, postApproval, expireApproval, refuseApproval, settleApproval } from './core/spore-dir.js'
export { mimeOf } from './core/call-record.js'
export { SCHEMA as EVENT_SCHEMA, EVENTS, PROMISED } from './observability/event-log.js'

export { cliLogger, silent } from './observability/logger.js'
export { formatTraceparent, parseTraceparent } from './observability/tracing.js'
export { errorText, SporeError, SEVERITY_TAGS, toWireError } from './observability/errors.js'
