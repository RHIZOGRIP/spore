#!/usr/bin/env node
/**
 * `$SPORE_JOB` — start work that outlives this turn.
 *
 * A program rather than a tool, for the reason `source` is. The runner launches the job's own
 * supervisor outside this turn; what the job writes, how it ends and what it says reach the
 * spore later, as messages.
 */

import { renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import minimist from 'minimist'

import { request } from '../src/infra/socket-request.js'
import { readModelKey } from '../src/core/spore-dir.js'

const argv = minimist(process.argv.slice(2), { '--': true, boolean: ['help'] })
const [verb, name] = argv._

const usage = `job — work that outlives this turn

Usage:
  node "$SPORE_JOB" start <name> -- <command>
  node "$SPORE_JOB" say <text>        from inside a job

  <name>     lowercase letters, digits, ., - and _; one job of a name runs at a time
  <command>  a shell command, run from the workspace root

The job writes only data/jobs/<name>/ (its TMPDIR is in there), can reach no model and no
source, and is stopped at the wall spore.cmk grants. Its output streams go to out and err in
that directory, beside status.json. How it ended is said to you as a message from job "<name>".

Inside the job, write data/jobs/<name>/progress (its last line is shown, no turn needed), and
say something only when it needs attention before the end. What it says waits while what it said
before is unread, and a newer say replaces it meanwhile.`

const saying = verb === 'say' && argv._.length > 1
if (argv.help || !(saying || (verb === 'start' && name && argv['--'].length))) {
  console.log(usage)
  process.exit(argv.help ? 0 : 2)
}

const fail = (problem, detail) => {
  console.error(`job: ${problem}${detail ? ` — ${detail}` : ''}`)
  process.exit(1)
}

if (saying) {
  const dir = process.env.SPORE_JOB_DIR
  if (!dir) fail('say is for a job', 'a turn is read as it goes; only a command started with start says something later')
  const pending = join(dir, `say.${process.pid}.tmp`)
  writeFileSync(pending, argv._.slice(1).join(' ') + '\n')
  renameSync(pending, join(dir, 'say'))
  console.log('said — it reaches the spore once what this job said before has been read; until then a newer say replaces it')
  process.exit(0)
}

if (process.env.SPORE_JOB_NAME) fail('a job cannot start a job', 'its own command may run anything in the background, and is stopped with it')
const socketPath = process.env.SPORE_JOB_SOCKET
if (!socketPath) fail('no job socket', 'this spore was granted no jobs — its owner grants them in spore.cmk, as jobs: [2, 2h]')

try {
  const begun = await request(socketPath, { key: readModelKey(process.cwd()), method: 'POST', path: '/start', body: { name, command: argv['--'].join(' ') }, what: 'job socket' })
  console.log(JSON.stringify(begun))
} catch (e) {
  fail(e.message, e.detail)
}
