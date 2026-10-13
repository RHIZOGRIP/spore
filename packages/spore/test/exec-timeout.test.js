import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeTools } from '../src/tools/make-tools.js'
import { createCallTrail, readCall } from '../src/core/call-record.js'
import { hostState } from '../src/core/spore-dir.js'
import { shownToModel } from './fixtures/as-shown.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.exec-timeout-workspace')

let wsexec

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(resolve(WS, 'data'), { recursive: true })
  wsexec = shownToModel(makeTools(WS, 50000, createCallTrail(WS, { runId: 'test', state: hostState(WS) })).fns).wsexec
})

afterEach(() => {
  rmSync(WS, { recursive: true, force: true })
})

describe('per-call timeout', () => {
  it('kills at the deadline and says which bound fired', async () => {
    const meta = JSON.parse(await wsexec({ command: 'sleep 30', out: 'data/o.txt', timeout: 2 }))
    expect(meta.killed).toBe('deadline')
    expect(meta.timeoutMs).toBe(2000)
    expect(meta.exit).toBeUndefined()
    expect(meta.signal).toBe('SIGTERM')
  }, 15000)

  it('escalates to SIGKILL for a command that ignores the ask', async () => {
    const meta = JSON.parse(await wsexec({
      command: "trap '' TERM; sleep 30",
      out: 'data/o.txt',
      timeout: 2
    }))
    expect(meta.killed).toBe('deadline')
    expect(meta.signal).toBe('SIGKILL')
  }, 15000)

  it('lets a long command finish when it is under its own timeout', async () => {
    const meta = JSON.parse(await wsexec({ command: 'sleep 3 && echo late', out: 'data/o.txt', timeout: 30 }))
    expect(meta.killed).toBeUndefined()
    expect(meta.exit).toBe(0)
    expect(meta.files.out.content).toBe('late\n')
  }, 15000)

  it('outlives the old fixed 30s bound', async () => {
    const meta = JSON.parse(await wsexec({ command: 'sleep 32 && echo survived', out: 'data/o.txt', timeout: 60 }))
    expect(meta.killed).toBeUndefined()
    expect(meta.exit).toBe(0)
    expect(meta.files.out.content).toBe('survived\n')
  }, 90000)

  it('kills the whole pipeline, not just the shell', async () => {
    const meta = JSON.parse(await wsexec({ command: 'sleep 30 | cat', out: 'data/o.txt', timeout: 2 }))
    expect(meta.killed).toBe('deadline')
    const survivors = JSON.parse(await wsexec({ command: 'pgrep -c "sleep 30" || true', out: 'data/p.txt', timeout: 10 }))
    expect(survivors.files.out.content.trim()).toBe('0')
  }, 20000)

  it('rejects a timeout beyond the ceiling', async () => {
    expect(await wsexec({ command: 'true', out: 'data/o.txt', timeout: 99999 })).toMatch(/timeout must be between/)
    expect(await wsexec({ command: 'true', out: 'data/o.txt', timeout: 0 })).toMatch(/timeout must be between/)
  })

  it('records progress while output is still arriving', async () => {
    const meta = JSON.parse(await wsexec({ command: 'for i in 1 2 3; do echo $i; sleep 1; done', out: 'data/o.txt', timeout: 30 }))
    expect(meta.killed).toBeUndefined()
    expect(meta.files.out.content).toBe('1\n2\n3\n')
    const trail = readCall(WS, 'test', meta.call)
    expect(new Date(trail.lastProgressAt).getTime()).toBeGreaterThan(new Date(trail.startedAt).getTime())
  }, 20000)
})

describe('idle detection', () => {
  const shortIdle = (ws, idleMs = 3000) => shownToModel(makeTools(ws, 50000, createCallTrail(ws, { runId: 'idle', state: hostState(ws) }), { idleMs }).fns).wsexec

  it('kills a command that stops making progress, well before its deadline', async () => {
    const meta = JSON.parse(await shortIdle(WS)({ command: 'sleep 30', out: 'data/o.txt', timeout: 60 }))
    expect(meta.killed).toBe('idle')
    expect(meta.idleMs).toBe(3000)
  }, 20000)

  it('spares a command that keeps writing output', async () => {
    const meta = JSON.parse(await shortIdle(WS)({ command: 'for i in 1 2 3 4 5 6; do echo $i; sleep 1; done', out: 'data/o.txt', timeout: 60 }))
    expect(meta.killed).toBeUndefined()
    expect(meta.files.out.content).toBe('1\n2\n3\n4\n5\n6\n')
  }, 30000)

  it('takes the idle window a call asks for', async () => {
    const meta = JSON.parse(await wsexec({ command: 'sleep 30', out: 'data/o.txt', timeout: 60, idle: 3 }))
    expect(meta.killed).toBe('idle')
    expect(meta.idleMs).toBe(3000)
  }, 20000)

  it('spares a silent wait given an idle window longer than it', async () => {
    const meta = JSON.parse(await shortIdle(WS)({ command: 'sleep 5; echo done', out: 'data/o.txt', timeout: 60, idle: 20 }))
    expect(meta.killed).toBeUndefined()
    expect(meta.files.out.content).toBe('done\n')
  }, 20000)

  it('never sets the idle window past the deadline, whether asked for or by default', async () => {
    const asked = JSON.parse(await wsexec({ command: 'true', out: 'data/o.txt', timeout: 10, idle: 120 }))
    expect(asked.exit).toBe(0)
    expect(readCall(WS, 'test', asked.call).idleMs).toBe(10000)
    const meta = JSON.parse(await wsexec({ command: 'true', out: 'data/o.txt' }))
    expect(readCall(WS, 'test', meta.call).idleMs).toBe(30000)
    expect(await wsexec({ command: 'true', out: 'data/o.txt', idle: 0 })).toMatch(/idle must be more than 0 seconds/)
  })

  // Outlives the 2s sampler tick with an idle window shorter than it, so the
  // CPU signal is the only thing keeping it alive.
  it('spares a silent command that is burning CPU', async () => {
    const meta = JSON.parse(await shortIdle(WS, 1500)({
      command: "awk 'BEGIN{for(i=0;i<150000000;i++)x+=i; print \"computed\"}'",
      out: 'data/o.txt',
      timeout: 60
    }))
    expect(meta.killed).toBeUndefined()
    expect(meta.files.out.content).toBe('computed\n')
    const trail = readCall(WS, 'idle', meta.call)
    expect(new Date(trail.lastProgressAt).getTime() - new Date(trail.startedAt).getTime()).toBeGreaterThan(1500)
  }, 40000)
})
