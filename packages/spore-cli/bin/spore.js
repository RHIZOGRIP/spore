#!/usr/bin/env node
/**
 * spore — say something to an agent in a workspace, and watch what it does.
 * Contract: ARCHITECTURE.md, "The spore command".
 *
 * This is the follower and holds nothing: `send` appends to the inbox and races
 * for the lock, the runner (native/<arch>/spore-runner) holds the lock and the slot, and
 * bin/spore-agent.js is the confined half. Ctrl-C here leaves the turn running.
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import minimist from 'minimist'

import { host } from '../src/vm.js'

await host(process.argv.slice(2))

const { differingDocs, fork, follow, followingDocs, grantOf, isWorkspace, lastEventSeq, loadEnvironment, mimeOf, readConfig, readInbox, RUNNING, send, stateOf, stop, turnOfMessage, turnSummary, watch, workspaceFor, errorText } = await import('@rhizogrip/spore')
const { renderHeader } = await import('../src/dispatch.js')
const { SERVICES } = await import('../src/services.js')

// Detaching is neither success nor failure: the turn is still going, and 0 would claim it
// answered. `spore show` says what actually happened once it has.
const DETACHED = 3
const WRAPPED = 4
const DEFAULT_TAIL = 50

const argv = minimist(process.argv.slice(2), {
  string: ['_', 'definition', 'from', 'sporangium', 'at', 'model', 'plugin', 'attach', 'request-id', 'after', 'since', 'until', 'tz', 'by', 'n', 'lines'],
  boolean: ['debug', 'help', 'version', 'yes', 'replay', 'json', 'all', 'outdated', 'f', 'clear', 'report'],
  alias: { h: 'help', n: 'lines' }
})

const VERBS = `Usage:
  spore setup                               the first run: this machine, your models, a first spore
  spore vm start|stop                       the Linux vm spore runs in, where spore setup made one
  spore define <name>                       say what a spore is; . for here
  spore define <name> --model <m> --plugin <p>  the same, with its model and plugins filled in
  spore define <new> --from <name>          the same, cut from one that has learned
  spore define <name> --sporangium <s>      the same, made from a sporangium — reviewer, or one of yours
  spore define <name> --definition <f>      the same, from that .cmk; given to one that exists, it revises it
  spore edit <name>                         its spore.cmk in $EDITOR, checked before it replaces the one in place
  spore send <name> <message>               start a turn, or land in the one running
  spore send <name> <message> --attach <f>  with a file — repeatable; the agent reads it where it lands
  spore send <name> <message> --request-id <id>  taken once: sent again under the id, it answers what the first got
  spore send <name> -- <message>            -- ends the options, for a message that starts with -
  spore send|attach <name> --json           for a program: the turn's events, one JSON object a line
  spore attach <name> --json --after <seq>  the events after <seq>; 0 for the whole log
  spore fork <name> <new>                   a copy as it stands between turns, schedules left behind
  spore fork <name> --at turn:<n> <new>     the same, as it stood after turn n
  spore fork <name> --at <call> <new> [--replay]  carry a turn on from one of its rounds, in a copy
  spore attach <name> [-n <lines>]          watch a turn that is already going
  spore stop <name>                         SIGTERM it, mid-round
  spore extend <name> wall 30m|cost 1.50|rounds 20  give the running turn more, up to its extend.<limit>
  spore wrap <name> [10m]                   ask the running turn to wrap up, now or in a while
  spore annotate <name> <line>|--clear      a line of yours under the running turn's header, wherever it is shown
  spore model [<name> [<model>]]            what it runs on and may switch to; with a model, switch from the next turn
  spore flush <name>                        its next turn starts over, replaying nothing said before; nothing is forgotten
  spore ls [<dir>]                          your spores and their state
  spore tui [<name>]                        talk to a spore in a terminal screen; the last one opened without a name
  spore here [<dir>]                        the spore that works in this directory, in place — made the first time
  spore here --sporangium <s> --model <m> --no-git  made from <s>, on <m>, without asking; outside git, nothing can be undone
  spore show [<name>]                       one spore in detail
  spore remake <name>                       make it again from its sporangium, keeping its files
  spore rm <name> [--yes]                   remove it; --yes once it has turns
  spore log [<name>]                        one line per turn, and what is waiting
  spore sql [<name> [<query>|-]]            its records, read with SQL; .tables lists the views, - the query on stdin
  spore usage [<name>] [--days 7]           what it spent per day, by origin, model, outcome, precursor
  spore usage --since <d> [--until <d>]     over those local days; --tz <zone>, --by <axis>, every spore without a name
  spore upgrade <name>|--all                its root docs replaced by what is installed
  spore plugin ls                           plugins installed beside spore, and which are allowed
  spore plugin allow <plugin> [k=v …]       checked, then recorded in config.json; disallow undoes it
  spore plugin show <plugin>                what it gives: settings, programs, env, docs, precursors
  spore schedule set <name> <sched> [<file>|-]  install schedules/<sched>.cmk, checked first; - or none reads stdin
  spore schedule rm <name> <sched>          remove one; what it fired stays in the inbox
  spore schedule ls [<name>]                its schedules, and why any is not firing
  spore tick                                fire every schedule that is due — run by a timer
  spore approval ask <name> [<request.json>|-]  ask people to choose, with buttons only they can press, where the request says
  spore approval ls <name>                  the approvals asked in it, and how each ended
  spore job ls [<name>]                     its jobs: running ones with their progress, ended ones how
  spore job stop <name> <job>               ask a running job's supervisor to stop it
  spore pause [why]                         stop every turn and job of your spores, and start none
  spore unpause                             let turns start again; what waited goes at the next tick
  spore service ls                          the services spore ships (${Object.keys(SERVICES).join(', ')}) and its plugins offer
  spore service define <svc>                write its systemd user unit, checked first
  spore service start|stop|restart <svc>    now; enable|disable: at every login
  spore service restart --outdated          every service running older code than is installed
  spore service show <svc>                  its state and last lines
  spore service log <svc> [-n <lines>] [-f]  its journal; -f follows it
  spore service rm <svc> [--yes]            remove it; --yes when that stops instances running
  spore hook ls                             the hooks in hooks.json, each one's spores and what it said to them this week
  spore hook show <hook>                    one hook: its checks, its last deliveries per spore, and its lines in the webhook journal
  spore config get [<key>]                  every setting in effect, defaults marked
  spore config set|add|rm|path              where workspaces live, and what your spores may use
  spore config set model <provider>/<name>  the model new spores run on, in your default sporangium
  spore doctor                              what is wrong on this machine, and the command that fixes each
  spore doctor --report                     this machine as a GitHub issue you read, then file or not — spore sends nothing`

if (!process.argv.slice(2).length) {
  console.log(`spore — AI agents you run on your own machines\n\n${VERBS}\n\n  spore --help                              all of it: the flags, and why\n  spore --version                           the installed version\n`)
  process.exit(0)
}

if (argv.version) {
  console.log(createRequire(import.meta.url)('../package.json').version)
  process.exit(0)
}

if (argv.help) {
  console.log(`spore — AI agents you run on your own machines

${VERBS}

  name          a spore in your home, or a path to one; the read verbs default to the
                one you are standing in
  message       read from stdin when not given
  --            ends the options, for a message that starts with -
  --definition  the .cmk to give it, instead of your default; for fork, the one the copy runs under
  --from        the spore to cut it from: what it can do, never what it did
  --json        for a program: the answer as JSON, with the same exit code
  --debug       verbose logging on stderr

send, attach and a fork at a call exit 0 when the turn answered, 1 when it ended with no answer,
3 when you walked away — Ctrl-C leaves the turn running, spore attach picks it up —
and 4 when it wrapped up at a soft limit, its answer saying what remains.

  ~/.config/spore   what you write: config.json, sporangia/, sources.json, environment
  home              what spore keeps: one folder per spore; spore setup offers ~/.spore

Everything else: https://github.com/RHIZOGRIP/spore/blob/main/packages/spore/README.md`)
  process.exit(0)
}

const withJson = (most, ...flags) => ({ flags: [...flags, 'json'], most })
const ALL = Infinity

// What each verb takes: the options it reads and how many words may follow it — per
// subcommand for a verb that has them, `bare` being the one it runs without. A message, a
// query, a reason to pause and a plugin's settings take every word left.
const SHAPES = {
  send: { flags: ['attach', 'request-id', 'json', 'debug'], most: ALL },
  fork: { flags: ['at', 'definition', 'replay', 'debug'], most: 2 },
  attach: { flags: ['n', 'lines', 'json', 'after'], most: 1 },
  stop: { flags: [], most: 1 },
  extend: withJson(3),
  wrap: withJson(2),
  annotate: withJson(ALL, 'clear'),
  model: withJson(2),
  flush: withJson(1),
  define: withJson(1, 'definition', 'from', 'sporangium', 'model', 'plugin'),
  edit: withJson(1),
  remake: withJson(1),
  rm: withJson(1, 'yes'),
  ls: withJson(1),
  show: withJson(1),
  log: withJson(1),
  sql: withJson(ALL),
  upgrade: withJson(1, 'all'),
  plugin: { bare: 'ls', subs: { ls: withJson(0), show: withJson(1), allow: withJson(ALL), disallow: withJson(1) } },
  schedule: { bare: 'ls', subs: { set: withJson(3), rm: withJson(2), ls: withJson(1) } },
  approval: { bare: 'ls', subs: { ask: withJson(2), ls: withJson(1) } },
  job: { bare: 'ls', subs: { ls: withJson(1), stop: withJson(2) } },
  tick: withJson(0),
  pause: withJson(ALL),
  unpause: withJson(0),
  service: {
    bare: 'ls',
    subs: {
      ls: withJson(0),
      define: withJson(1),
      start: withJson(1),
      stop: withJson(1),
      restart: withJson(1, 'outdated'),
      enable: withJson(1),
      disable: withJson(1),
      show: withJson(1),
      log: { flags: ['n', 'lines', 'f'], most: 1 },
      rm: withJson(1, 'yes')
    }
  },
  config: { bare: 'get', subs: { get: withJson(1), set: withJson(2), add: withJson(2), rm: withJson(2), path: withJson(0) } },
  usage: withJson(1, 'days', 'since', 'until', 'tz', 'by'),
  doctor: withJson(0, 'report'),
  hook: { bare: 'ls', subs: { ls: withJson(0), show: withJson(1) } },
  tui: { flags: [], most: 1 },
  here: { flags: ['sporangium', 'model', 'no-git'], most: 1 },
  setup: { flags: [], most: 0 },
  vm: { subs: { start: { flags: [], most: 0 }, stop: { flags: [], most: 0 } } }
}
const verb = argv._[0]

const distance = (a, b) => {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    row = next
  }
  return row[b.length]
}

if (!Object.hasOwn(SHAPES, verb)) {
  const verbs = Object.keys(SHAPES)
  const near = verb ? verbs.map(known => ({ known, d: distance(verb, known) })).filter(v => v.d <= 2).sort((a, b) => a.d - b.d)[0] : null
  const looksLikeAPrompt = !near && (argv._.length || !process.stdin.isTTY)
  console.error(`spore: ${verb ? `unknown command "${verb}"` : 'no command'}${near ? ` — did you mean ${near.known}?` : ` — one of ${verbs.join(', ')}`}` +
    (looksLikeAPrompt ? '\n       a turn is `spore send <name> <message>`' : '') +
    '\n       spore alone lists what each one does')
  process.exit(2)
}

/**
 * The options on the command line as typed, before `--`: minimist sets every declared boolean
 * whether it was given or not, and an alias under both names.
 */
function typed (args) {
  const end = args.indexOf('--')
  return (end < 0 ? args : args.slice(0, end)).filter(arg => arg.startsWith('-') && arg !== '-').flatMap(arg => {
    if (arg.startsWith('--')) return [arg.slice(2).split('=')[0]]
    const letters = arg.slice(1).match(/^[A-Za-z]+/)
    return letters ? [...letters[0]] : [arg.slice(1)]
  })
}

const dashed = (name) => (name.length === 1 ? `-${name}` : `--${name}`)
const given = typed(process.argv.slice(2))

if (argv.attach !== undefined && verb !== 'send') fail(`--attach is for send — a file goes with a message, and ${verb} sends none`)

const { subs, bare } = SHAPES[verb]
const sub = argv._[1] ?? bare
const shape = !subs ? SHAPES[verb] : Object.hasOwn(subs, sub) ? subs[sub] : null
if (shape) {
  const label = subs ? `${verb} ${sub}` : verb
  const unknown = given.filter(name => !shape.flags.includes(name))
  if (unknown.length) {
    fail(`unknown option ${unknown.map(dashed).join(', ')} — ${label} takes ${shape.flags.length ? shape.flags.map(dashed).join(', ') : 'no option'}`)
  }
  if (argv.n !== undefined && !/^\d+$/.test(argv.n)) fail(`-n ${argv.n} is not a number of lines`)
  const extra = argv._.slice(subs ? 2 : 1).slice(shape.most)
  if (extra.length) {
    const most = shape.most === 0 ? 'no argument' : shape.most === 1 ? 'at most one argument' : `at most ${shape.most} arguments`
    fail(`${label} takes ${most} — ${extra.map(word => `"${word}"`).join(', ')} ${extra.length > 1 ? 'are' : 'is one'} too many`)
  }
}

try {
  loadEnvironment()
} catch (err) {
  if (verb !== 'doctor') fail(errorText(err))
}

if (verb === 'tui') {
  const { mostRecentSpore, rememberedSpore, runTui } = await import('../tui/index.js')
  const remembered = rememberedSpore()
  const ws = argv._[1] ? spore(argv._[1]) : remembered && isWorkspace(remembered) ? remembered : mostRecentSpore()
  if (!ws) fail('no spore yet — spore define <name>')
  process.exit(await runTui({ ws }))
}

if (verb === 'setup') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail('setup asks questions, and this is not a terminal — the same steps are spore config set home <dir>, ' +
      'mo onboard <provider>, spore config set model <provider>/<name>, spore doctor')
  }
  const { setup } = await import('../src/setup.js')
  try {
    process.exit(await setup())
  } catch (err) {
    if (!err.type) throw err
    fail(errorText(err))
  }
}

if (verb === 'here') {
  const { here } = await import('../tui/here.js')
  try {
    process.exit(await here({ dir: argv._[1], sporangium: argv.sporangium, model: argv.model, git: argv.git !== false }))
  } catch (err) {
    if (!err.type) throw err
    fail(errorText(err))
  }
}

if (!['send', 'fork', 'attach', 'stop'].includes(verb)) {
  const { manage } = await import('../src/dispatch.js')
  process.exit(await manage(verb, argv))
}

// An answer given at a soft limit says what remains and is not the finished one, so a caller
// that takes stdout as the result is told apart from a turn that answered.
function exitOf (turn) {
  if (!turn?.concluded) return 1
  if (!turn.stopReason?.startsWith('soft:')) return 0
  process.stderr.write(`\nspore: it wrapped up at its ${turn.stopReason.slice(5)} limit — the answer says what remains; send again to carry on\n`)
  return WRAPPED
}

const exitFor = (ws) => exitOf(turnSummary(ws).last)

/** The finished turn that ended the message at `inbox`, and whether it read it; null while none has. */
function answeredBy (ws, inbox) {
  const [entry] = readInbox(ws, { after: inbox - 1, upto: inbox })
  return entry ? turnOfMessage(ws, entry) : null
}

const line = (object) => process.stdout.write(JSON.stringify(object) + '\n')

/** The event log as JSON lines, from `after` until the running turn ends; true when Ctrl-C cut it. */
async function events (ws, after) {
  const leaving = new AbortController()
  process.on('SIGINT', () => leaving.abort())
  for await (const event of watch(ws, { after, signal: leaving.signal })) line(event)
  return leaving.signal.aborted
}

function fail (problem) {
  console.error(`spore: ${problem}`)
  process.exit(2)
}

async function readStdin () {
  if (process.stdin.isTTY) return ''
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

const [, asked, ...rest] = argv._

function spore (name, { needed = true } = {}) {
  let target
  try {
    target = workspaceFor(name)
  } catch (err) {
    fail(errorText(err))
  }
  if (needed && !isWorkspace(target.path)) {
    fail(target.named
      ? `no spore called "${name}" in ${target.home} — spore define ${name}`
      : `${target.path} is not a workspace — spore define ${name}`)
  }
  return target.path
}

if (verb === 'stop') {
  if (!asked) fail('stop needs a spore — spore stop <name>')
  const ws = spore(asked)
  let result
  try {
    result = stop(ws)
  } catch (err) {
    fail(`could not stop ${ws} — ${err.message}`)
  }
  if (!result.stopped) {
    console.error(`spore: nothing running in ${ws}`)
    process.exit(1)
  }
  console.error(`spore: stopping ${ws} (pid ${result.pid})`)
  process.exit(0)
}

if (verb === 'fork') {
  const [into] = rest
  if (!asked || !into) fail('fork needs a spore and somewhere new — spore fork <name> [--at turn:<n> | --at <call> [--replay]] <new> [--definition <f>]')
  let made
  try {
    made = fork({ run: spore(asked), at: argv.at, into: workspaceFor(into).path, definition: argv.definition, replay: argv.replay, debug: argv.debug })
  } catch (err) {
    fail(errorText(err))
  }
  if (made.pid === undefined) {
    console.error(`spore: forked ${made.from} after turn ${made.turnNo} into ${made.ws} — its next message starts its first turn`)
    process.exit(0)
  }
  console.error(`spore: forked ${made.from} at ${made.at}, round ${made.rounds} — carrying it on in ${made.ws}`)
  renderHeader(made.ws, grantOf(made.ws))
  const ended = await follow(made.ws, { lines: 0, status: true })
  if (ended === 'detached') {
    process.stderr.write(`\nspore: still running — spore attach ${made.ws}\n`)
    process.exit(DETACHED)
  }
  process.exit(exitFor(made.ws))
}

if (verb === 'attach') {
  if (!asked) fail('attach needs a spore — spore attach <name>')
  const ws = spore(asked)
  if (argv.json) {
    if (given.includes('n') || given.includes('lines')) fail('-n is for a person watching — --json follows the event log, from --after <seq>')
    const after = argv.after === undefined ? lastEventSeq(ws) : Number(argv.after)
    if (!Number.isInteger(after) || after < 0) fail(`--after ${argv.after} is not an event's seq — a whole number, 0 for the whole log`)
    process.exit(await events(ws, after) ? DETACHED : exitFor(ws))
  }
  if (argv.after !== undefined) fail('--after is for --json — spore attach <name> --json --after <seq>')
  const tail = argv.n
  const running = stateOf(ws).state === RUNNING
  const ended = await follow(ws, { lines: tail !== undefined ? Number(tail) : running ? 0 : DEFAULT_TAIL, status: true })
  process.exit(ended === 'detached' ? DETACHED : exitFor(ws))
}

const ws = spore(asked || fail('send needs a spore and a message — spore send <name> <message>, or . for the one here'))

const attached = (file) => {
  const path = resolve(String(file))
  let data
  try {
    data = readFileSync(path)
  } catch (err) {
    fail(`--attach ${file} cannot be read — ${err.message}`)
  }
  return { name: basename(path), mime: mimeOf(path), data }
}
const attach = [].concat(argv.attach ?? []).map(attached)
const message = (rest.join(' ') || await readStdin()).trim()
if (!message && !attach.length) fail('no message — pass one as an argument or on stdin, or a file with --attach')

let differs
let followed
try {
  differs = differingDocs(ws)
  followed = followingDocs(readConfig())
} catch (err) {
  fail(errorText(err))
}
if (differs.length && !followed) console.error(`spore: ${differs.map(d => d.file).join(', ')} differ from what is installed — spore upgrade ${asked}`)

const requestId = argv['request-id'] || undefined
const after = lastEventSeq(ws)

let grant
let sent
try {
  grant = grantOf(ws)
  sent = send(ws, message, { attach, requestId, replyTo: 'terminal', debug: argv.debug })
} catch (err) {
  fail(errorText(err))
}

// Sent before under this request id and already ended: nothing runs, and what it got is on
// the record.
const settled = sent.repeated && !sent.started && stateOf(ws).state !== RUNNING

const dreaming = !sent.started && !settled && stateOf(ws).dreaming
if (dreaming) console.error('spore: it is dreaming — your message waits for it to wake, and the turn after the dream reads it')

if (argv.json) {
  line({ event: 'sent', inbox: sent.inbox, started: sent.started, repeated: sent.repeated })
  if (!settled && await events(ws, after)) process.exit(DETACHED)
  const found = answeredBy(ws, sent.inbox)
  line({ event: 'result', read: found?.read ?? false, turn: found?.turn ?? null })
  process.exit(exitOf(found?.read ? found.turn : null))
}

if (settled) {
  const found = answeredBy(ws, sent.inbox)
  if (found?.read && found.turn.output != null) process.stdout.write(found.turn.output + '\n')
  process.stderr.write(`spore: already sent under ${requestId} — ${found?.read ? `turn ${found.turn.turnNo} answered it` : 'no turn read it'}\n`)
  process.exit(exitOf(found?.read ? found.turn : null))
}

if (sent.started) renderHeader(ws, grant)

const ended = await follow(ws, { lines: 0, status: true })
if (ended === 'detached') {
  process.stderr.write(`\nspore: still running — spore attach ${asked}\n`)
  process.exit(DETACHED)
}

process.exit(exitFor(ws))
