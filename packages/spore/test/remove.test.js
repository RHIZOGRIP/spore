/**
 * `spore rm`, against workspaces laid out the way `define` and a runner leave them — outside
 * the checkout and `/tmp`, which it refuses as it should.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { remove } from '../src/library/verbs.js'
import { acquireLock, appendTurn, releaseLock } from '../src/core/spore-dir.js'
import { stateOf } from '../src/core/state.js'
import { outsideRoot } from './fixtures/outside-ws.js'

const DEFINITION = '---\nname: t\nmodel: anthropic/claude-haiku-4-5\ntools: [read]\nrounds: [2, 3]\ncost: [0.1, 0.2]\nwall: [1m, 2m]\n---\n\nyou are a test.\n'

let root
let home
let config

const spore = (path) => {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'spore.cmk'), DEFINITION)
  return path
}

const paid = (ws) => appendTurn(ws, { startedAt: new Date().toISOString(), concluded: true, stopReason: 'answer', ownMicros: 20_000, treeMicros: 20_000 })

beforeEach(() => {
  root = outsideRoot('spore-rm')
  home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  config = join(root, 'config.json')
  writeFileSync(config, JSON.stringify({ home }))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const rm = (ws, options = {}) => remove({ ws, configFile: config, ...options })

describe('spore rm', () => {
  it('removes a spore that never ran', () => {
    const ws = spore(join(home, 'fresh'))
    expect(rm('fresh')).toMatchObject({ ws, turns: 0, treeUsd: 0 })
    expect(existsSync(ws)).toBe(false)
  })

  it('refuses one with recorded turns, and removes it when told to', () => {
    const ws = spore(join(home, 'worked'))
    paid(ws)
    expect(() => rm('worked')).toThrow(expect.objectContaining({ type: 'SPORE_HAS_TURNS' }))
    expect(existsSync(ws)).toBe(true)
    expect(rm('worked', { yes: true })).toMatchObject({ ws, turns: 1, treeUsd: 0.02 })
    expect(existsSync(ws)).toBe(false)
  })

  it('refuses one that is running, and leaves it where it is', () => {
    const ws = spore(join(home, 'busy'))
    acquireLock(ws)
    try {
      expect(() => rm('busy', { yes: true })).toThrow(expect.objectContaining({ type: 'SPORE_RUNNING', detail: 'spore stop busy first' }))
      expect(existsSync(join(ws, 'spore.cmk'))).toBe(true)
    } finally {
      releaseLock(ws)
    }
  })

  it('leaves a crashed spore looking crashed when it refuses to remove it', () => {
    const ws = spore(join(home, 'crashed'))
    paid(ws)
    writeFileSync(join(ws, 'lock'), JSON.stringify({ pid: 2 ** 22 + 7, startedAt: 'then' }))
    expect(() => rm('crashed')).toThrow(expect.objectContaining({ type: 'SPORE_HAS_TURNS' }))
    expect(stateOf(ws).state).toBe('crashed')
  })

  it('refuses a directory that is not a spore', () => {
    mkdirSync(join(home, 'plain'))
    expect(() => rm('plain')).toThrow(expect.objectContaining({ type: 'NOT_A_WORKSPACE' }))
    expect(existsSync(join(home, 'plain'))).toBe(true)
  })

  it('refuses a spore where the sandbox grants every path', () => {
    const ws = spore(resolve(tmpdir(), `spore-rm-${process.pid}`))
    try {
      expect(() => rm(ws)).toThrow(expect.objectContaining({ type: 'WORKSPACE_REFUSED' }))
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})
