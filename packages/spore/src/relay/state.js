import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { SporeError } from '../observability/errors.js'

export const statePath = (kind, bot, env = process.env) =>
  join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'spore', kind, bot, 'state.json')

const fieldsOf = (spec) => ['cursors', 'pending', ...spec.stateFields]

const unreadable = (spec, path, why) => new SporeError(`${path} is not readable`, {
  type: `${spec.kind.toUpperCase()}_STATE_INVALID`,
  detail: `${why} — it holds where the bot stood; move it aside to start from now`
})

/**
 * `cursors` is `watchAll`'s, per workspace. `pending` is, per workspace, every message that reached
 * it and no turn has answered yet: its `inbox` number, its `conversation`, the platform's id of the
 * message it answers (`asked`) and the `working…` message's (`note`). The adapter's own fields
 * follow, as its `stateFields` name them.
 */
export function loadState (path, spec) {
  if (!existsSync(path)) return Object.fromEntries(fieldsOf(spec).map(field => [field, {}]))
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw unreadable(spec, path, err.message)
  }
  const missing = fieldsOf(spec).filter(field => typeof raw[field] !== 'object' || raw[field] === null)
  if (missing.length) throw unreadable(spec, path, `it has no ${missing.join(', ')}`)
  const pending = Object.values(raw.pending).flat()
  if (!pending.every(entry => Number.isInteger(entry.inbox) && typeof entry.conversation === 'string')) {
    throw unreadable(spec, path, 'a message it waits on has no inbox number or conversation, as one an earlier version of the plugin wrote while a turn ran')
  }
  return Object.fromEntries(fieldsOf(spec).map(field => [field, raw[field]]))
}

/** Written whole and renamed into place, readable by its owner alone: it names conversations and messages. */
export function saveState (path, state, spec) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const written = `${path}.${process.pid}`
  writeFileSync(written, JSON.stringify(Object.fromEntries(fieldsOf(spec).map(field => [field, state[field]])), null, 2), { mode: 0o600 })
  renameSync(written, path)
}
