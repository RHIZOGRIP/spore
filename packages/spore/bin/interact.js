#!/usr/bin/env node
/**
 * `$SPORE_INTERACT` — ask a handler the operator describes for something, and hear the result
 * later as a message.
 *
 * A program rather than a tool, for the reason `job` is. The runner freezes the data, stamps
 * where the answer goes and hands it to the handler; the agent sees a handler's name and what it
 * does, never its address or a credential.
 */

import { realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import minimist from 'minimist'

import { request } from '../src/infra/socket-request.js'
import { readTreeKey } from '../src/core/spore-dir.js'

const argv = minimist(process.argv.slice(2), { string: ['route', 'key', 'supersedes', 'expires'], boolean: ['help'] })
const [verb, subject] = argv._

const usage = `interact — ask a handler for something, and hear the result later

Usage:
  node "$SPORE_INTERACT" handlers
  node "$SPORE_INTERACT" create <handler> <dir> [--route <r>] [--key <k>] [--supersedes <id>] [--expires <instant>]
  node "$SPORE_INTERACT" status <id>
  node "$SPORE_INTERACT" ls
  node "$SPORE_INTERACT" cancel <id>

handlers lists the handlers this spore may ask, and what each does.

<dir> is a directory under data/ holding the data for the handler, whatever it takes. Every regular
file in it is sent as it is; a link, or anything but files and directories, is refused.

create answers the interaction's id, and a link when the handler gives one. Put the link in your
answer, so whoever must act can open it, and end the turn: the result comes back as a message,
maybe long after, and a turn waiting for it waits for nothing. Never poll status.

--route    where the answer to the result goes, when this turn was asked from more than one place
--key      makes a retry safe: the same key with the same data answers the interaction made
--supersedes  replaces an open interaction with this changed data
--expires  an ISO instant after which it can no longer be answered; left out, it never expires`

const [, , dir] = argv._
const ok = { create: Boolean(subject && dir), status: Boolean(subject), cancel: Boolean(subject), ls: true, handlers: true }
if (argv.help || !ok[verb]) {
  console.log(usage)
  process.exit(argv.help ? 0 : 2)
}

const fail = (problem, detail) => {
  console.error(`interact: ${problem}${detail ? ` — ${detail}` : ''}`)
  process.exit(1)
}

const socketPath = process.env.SPORE_INTERACT_SOCKET
if (!socketPath) fail('no interact socket', 'this spore was granted no interactions — its owner grants them in spore.cmk, as interactions: 2')
const ws = process.env.SPORE_WS
if (!ws) fail('SPORE_WS is not set', 'interact runs inside a spore\'s turn, whose runner names the workspace holding the tree\'s key')

const body = verb === 'create'
  ? {
      handler: subject,
      dir: relative(realpathSync(ws), resolve(dir)),
      ...Object.fromEntries(['route', 'key', 'supersedes', 'expires'].filter(flag => argv[flag] !== undefined).map(flag => [flag, argv[flag]]))
    }
  : verb === 'ls' || verb === 'handlers' ? {} : { id: subject }

try {
  const answered = await request(socketPath, { key: readTreeKey(ws), method: 'POST', path: `/${verb === 'ls' ? 'list' : verb}`, body, what: 'interact socket' })
  console.log(JSON.stringify(answered))
} catch (e) {
  fail(`${e.type}: ${e.message}`, e.detail)
}
