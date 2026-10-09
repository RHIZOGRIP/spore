import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { SporeError } from '@rhizogrip/spore'

export const statePath = (bot, env = process.env) =>
  join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'spore', 'telegram', bot, 'state.json')

/**
 * `cursors` is `watchAll`'s, per workspace. `pending` is, per workspace, every message a chat
 * sent that no turn has answered yet: its `inbox` number, the chat, and the `working…`
 * message the answer is edited into.
 */
export function loadState (path) {
  if (!existsSync(path)) return { cursors: {}, pending: {} }
  try {
    const { cursors, pending } = JSON.parse(readFileSync(path, 'utf8'))
    return { cursors, pending }
  } catch (err) {
    throw new SporeError(`${path} is not readable`, {
      type: 'TELEGRAM_STATE_INVALID',
      detail: `${err.message} — it holds where the bot stood; move it aside to start from now`
    })
  }
}

export function saveState (path, { cursors, pending }) {
  mkdirSync(dirname(path), { recursive: true })
  const written = `${path}.${process.pid}`
  writeFileSync(written, JSON.stringify({ cursors, pending }, null, 2))
  renameSync(written, path)
}
