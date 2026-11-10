#!/usr/bin/env node
/**
 * The runner's helper for `$SPORE_INTERACT`, started for each request outside the agent's
 * confinement, with what the runner stamped — and `spore tick`'s, to hand over what is still
 * asked. It reads the operator's config and secrets, which no turn sees, and answers one JSON line:
 * what was done, or `{ refused: { status, type, message, detail } }`. Contract:
 * docs/interactions.md.
 */

import minimist from 'minimist'

import { loadEnvironment } from '../src/library/config.js'
import { cancelOne, createInteraction, handAsked, handlersFor, interactionList, interactionStatus } from '../src/core/interactions.js'

const argv = minimist(process.argv.slice(2), { string: ['ws', 'id', 'handler', 'handlers', 'route', 'origin', 'most', 'key', 'supersedes', 'expires'] })
const [verb] = argv._
const { ws, id } = argv

const answer = (line) => process.stdout.write(JSON.stringify(line) + '\n')

try {
  loadEnvironment()
  const options = { env: process.env }
  if (verb === 'create') {
    answer(await createInteraction(ws, {
      handler: argv.handler,
      id,
      turnId: JSON.parse(argv.origin).turnId,
      route: argv.route,
      origin: JSON.parse(argv.origin),
      most: Number(argv.most),
      key: argv.key ?? null,
      supersedes: argv.supersedes ?? null,
      expires: argv.expires,
      ...options
    }))
  } else if (verb === 'handlers') answer({ handlers: handlersFor(JSON.parse(argv.handlers)) })
  else if (verb === 'status') answer(await interactionStatus(ws, id, options))
  else if (verb === 'list') answer({ interactions: interactionList(ws) })
  else if (verb === 'cancel') answer(await cancelOne(ws, id, options))
  else if (verb === 'hand') answer(await handAsked(ws, options))
  else throw new Error(`no verb ${JSON.stringify(verb)} — create, handlers, status, list, cancel or hand`)
} catch (err) {
  answer({ refused: { status: err.status ?? 500, type: err.type ?? 'INTERACTION_FAILED', message: err.message, detail: err.detail ?? '' } })
  process.exitCode = 1
}
