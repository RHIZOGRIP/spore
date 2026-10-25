import { spawnSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import { defaultModel, define, isWorkspace, SporeError, sporangia, workspaceFor } from '@rhizogrip/spore'

import { changesSince, diffArgs, gitStateText, pruneSnapshots, snapshot, sporeNameFor, undoTo, workTreeOf } from '../src/here.js'
import { choose, runTui } from './index.js'

const WHAT = { M: 'restore', D: 'bring back', A: 'remove' }

function gitCommands (dir, spore) {
  const session = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')
  const since = snapshot(dir, { spore, session })
  pruneSnapshots(dir, { spore })
  return [
    {
      name: 'diff',
      description: 'what changed here since this session opened — your own changes too',
      run: (args, { outside, notice }) => {
        if (!changesSince(dir, since).length) return notice('nothing has changed since this session opened')
        const { cwd, args: diff } = diffArgs(dir, since)
        outside(() => spawnSync('git', diff, { cwd, stdio: 'inherit' }))
      }
    },
    {
      name: 'undo',
      description: 'put this directory back as it was when this session opened',
      run: async (args, { running, confirm, notice }) => {
        if (running()) return notice('a turn is running — stop it first (esc twice)')
        const changes = changesSince(dir, since)
        if (!changes.length) return notice('nothing to undo — the directory is as this session found it')
        const agreed = await confirm('undo this session', changes.map(c => `${WHAT[c.status]} ${c.path}`).join('\n'), 'put it back')
        if (!agreed) return
        undoTo(dir, since)
        notice(`put back ${changes.length} file${changes.length > 1 ? 's' : ''}`)
      }
    }
  ]
}

/**
 * Opens the spore `dir` is worked in by, making it the first time from the sporangium picked —
 * or named, which is the only way without a terminal. Resolves with the exit code.
 */
export async function here ({ dir = '.', sporangium = null, model = null, git = true, interactive = process.stdin.isTTY }) {
  const target = realpathSync(resolve(dir))
  if (!statSync(target).isDirectory()) throw new SporeError(`${target} is not a directory`, { type: 'HERE_REFUSED', detail: 'spore here works in a directory' })
  const tree = workTreeOf(target)
  if (!tree && git) {
    throw new SporeError(`${target} is not in a git repository`, {
      type: 'HERE_REFUSED',
      detail: 'git is what undoes what the spore changes — git init there, or --no-git to work without it'
    })
  }
  const name = sporeNameFor(target)
  const { path: ws } = workspaceFor(name)
  if (isWorkspace(ws) && (sporangium || model)) {
    throw new SporeError(`${target} already has its spore, ${name}`, {
      type: 'DEFINE_FILLS_ONLY_NEW',
      detail: `--sporangium and --model make a new one; this one exists, so spore edit ${name} changes it`
    })
  }
  if (!isWorkspace(ws)) {
    let chosen = sporangium
    if (!chosen) {
      if (!interactive) {
        throw new SporeError(`${target} has no spore yet, and without a terminal there is no picker`, { type: 'HERE_REFUSED', detail: 'name one: --sporangium <name>' })
      }
      if (!model && !defaultModel().model) {
        throw new SporeError(`new spores run on your default model, and ${defaultModel().path} names none`, {
          type: 'HERE_REFUSED',
          detail: 'spore config set model <provider>/<name>, or spore here --model <provider>/<name> — "mo ls" lists your catalog'
        })
      }
      chosen = await choose({
        title: `a spore for ${basename(target)}`,
        header: [`writes ${target}`, tree ? gitStateText(target) : 'not a git repository — nothing can be undone'],
        items: sporangia().map(s => ({ value: s.name, label: s.name, description: s.error ?? s.description ?? '' }))
      })
      if (!chosen) return 0
    }
    define({ ws: name, sporangium: chosen, model, writes: [`here=${target}`] })
  }
  return runTui({ ws, commands: tree ? gitCommands(target, name) : [], greeting: `${name} works in ${target} — its workspace is ${ws}` })
}
