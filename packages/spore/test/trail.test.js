import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeCall } from '../src/core/call-record.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TRAIL = resolve(dirname(__dirname), 'scripts/trail.js')
const WS = resolve(__dirname, '.trail-workspace')

const record = (runId, call, meta) => writeCall(WS, runId, call, { call, startedAt: '2026-09-27T00:00:00.000Z', ...meta })

const run = (...args) => execFileSync(process.execPath, [TRAIL, '-w', WS, ...args], {
  encoding: 'utf8',
  env: { ...process.env, FORCE_COLOR: '0' }
})

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
  record('runa', '0001', { tool: 'write', exit: 0, durationMs: 5, files: { out: { path: 'data.txt', bytes: 11 } } })
  record('runa', '0002', {
    tool: 'exec',
    exit: 1,
    durationMs: 6,
    command: 'cat missing.txt',
    files: { err: { path: 'err/runa/0002', bytes: 44, content: 'cat: missing.txt: No such file or directory\n' } }
  })
  record('runa', '0003', { tool: 'wsexec', killed: 'deadline', durationMs: 2005, command: 'sleep 5' })
})

afterEach(() => {
  rmSync(WS, { recursive: true, force: true })
})

describe('trail', () => {
  it('shows each call with its outcome and what it did', () => {
    const out = run()
    expect(out).toMatch(/run runa · 3 calls/)
    expect(out).toMatch(/0001 +write +0 .*→ data\.txt \(11 B\)/)
    expect(out).toMatch(/0002 +exec +1 .*cat missing\.txt/)
    expect(out).toMatch(/0003 +wsexec +deadline .*sleep 5/)
  })

  it('prints the error text of a failed call, which is what a post-mortem wants', () => {
    const out = run()
    expect(out).toMatch(/cat: missing\.txt: No such file or directory/)
    expect(out).toMatch(/2 of 3 calls failed/)
  })

  it('lists runs when asked', () => {
    record('runb', '0001', { tool: 'read', durationMs: 1, path: 'x.txt', lines: 2 })
    const out = run('--list')
    expect(out).toMatch(/runa +3 calls +2 failed/)
    expect(out).toMatch(/runb +1 calls/)
  })

  it('selects a run by name', () => {
    record('runb', '0001', { tool: 'read', durationMs: 1, path: 'x.txt', lines: 2 })
    expect(run('runb')).toMatch(/run runb · 1 calls/)
  })

  it('says so when a workspace has no trail', () => {
    rmSync(WS, { recursive: true, force: true })
    mkdirSync(WS, { recursive: true })
    expect(() => run()).toThrow(/no calls recorded/)
  })
})
