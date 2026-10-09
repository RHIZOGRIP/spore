import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeTools } from '../src/tools/make-tools.js'
import { createCallTrail } from '../src/core/call-record.js'
import { hostState } from '../src/core/spore-dir.js'
import { shownToModel } from './fixtures/as-shown.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.cancel-tree-workspace')
const MARK = `sporecanceltest${process.pid}`

// Anchored: an unanchored pattern also matches the shell execSync itself runs,
// whose command line contains the marker.
const alive = () => execSync(`pgrep -f "^node data/${MARK}.js" || true`).toString().trim().split('\n').filter(Boolean).length
const deafAlive = () => execSync(`pgrep -f "^node data/${MARK}-deaf.js" || true`).toString().trim().split('\n').filter(Boolean).length

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(resolve(WS, 'data'), { recursive: true })
  writeFileSync(resolve(WS, `data/${MARK}.js`), 'setTimeout(() => {}, 60000)')
  // Ignores SIGTERM, so only the escalation reaches it.
  writeFileSync(resolve(WS, `data/${MARK}-deaf.js`), "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)")
})

afterEach(() => {
  // Anchored for the same reason: an unanchored pkill kills the shell running it.
  try { execSync(`pkill -9 -f "^node data/${MARK}" || true`) } catch {}
  rmSync(WS, { recursive: true, force: true })
})

describe('cancellation reaches the whole tree', () => {
  const wsexec = () => shownToModel(makeTools(WS, 50000, createCallTrail(WS, { runId: 'cancel', state: hostState(WS) })).fns).wsexec

  // A grandchild backgrounded out of the shell survives killing the shell alone.
  // It dies here because the command is spawned detached and the signal goes to
  // the process group — which is what a spawned cell rides on too.
  it('kills a grandchild the shell backgrounded, not just the shell', async () => {
    const ac = new AbortController()
    const running = wsexec()({ command: `node data/${MARK}.js & sleep 30`, out: 'data/o.txt' }, { signal: ac.signal })
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(alive()).toBeGreaterThan(0)

    ac.abort()
    await running
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(alive()).toBe(0)
  }, 20000)

  // The shell dies on SIGTERM immediately, which is exactly when escalation still
  // matters: clearing the SIGKILL timer once the shell closed left a descendant
  // that ignores the signal running for as long as it liked.
  it('escalates to a descendant that ignores SIGTERM after its shell is gone', async () => {
    const ac = new AbortController()
    const running = wsexec()({ command: `node data/${MARK}-deaf.js & sleep 30`, out: 'data/o.txt' }, { signal: ac.signal })
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(deafAlive()).toBeGreaterThan(0)

    ac.abort()
    await running
    // No sleep: the call does not resolve until the escalation has run. Waiting here
    // was what hid the real lifecycle — the CLI exits as soon as it can, and an
    // unreferenced timer is discarded at exit.
    expect(deafAlive()).toBe(0)
  }, 20000)

  it('reaches the tree on a deadline too, not only on an abort', async () => {
    const meta = JSON.parse(await wsexec()({
      command: `node data/${MARK}.js & sleep 30`,
      out: 'data/o.txt',
      timeout: 2
    }))
    expect(meta.killed).toBe('deadline')
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(alive()).toBe(0)
  }, 20000)
})
