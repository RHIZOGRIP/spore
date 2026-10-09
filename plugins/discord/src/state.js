import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { SporeError } from '@rhizogrip/spore'

export const statePath = (bot, env = process.env) =>
  join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'spore', 'discord', bot, 'state.json')

const FIELDS = ['cursors', 'pending', 'hooks', 'guilds', 'roles', 'unheard']

/**
 * `cursors` is `watchAll`'s, per workspace. `pending` is, per workspace, every message that
 * addressed it and no turn has answered yet: its `inbox` number, the channel, who asked and the
 * first line of what they said, and the `working…` post removed once the answer is posted. `hooks` is
 * each channel's webhook, its token among them, which is why the file is the owner's alone.
 * `guilds` is each channel's guild, `roles` each guild's role per spore, and `unheard` how many
 * messages each channel has had since each spore last posted there.
 */
export function loadState (path) {
  if (!existsSync(path)) return Object.fromEntries(FIELDS.map(field => [field, {}]))
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return Object.fromEntries(FIELDS.map(field => [field, raw[field]]))
  } catch (err) {
    throw new SporeError(`${path} is not readable`, {
      type: 'DISCORD_STATE_INVALID',
      detail: `${err.message} — it holds where the bot stood; move it aside to start from now`
    })
  }
}

export function saveState (path, state) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const written = `${path}.${process.pid}`
  writeFileSync(written, JSON.stringify(Object.fromEntries(FIELDS.map(field => [field, state[field]])), null, 2), { mode: 0o600 })
  renameSync(written, path)
}
