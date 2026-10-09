import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { acquireLock, appendEvents, appendTranscript, dataDir, definitionPath, lockPath, pruneTrail, readEvents, readLock, readTranscript, readTranscriptEntries, releaseLock, statePath, writableDirs, writeTranscriptEntries } from '../src/core/spore-dir.js'
import { callRuns, writeCall } from '../src/core/call-record.js'
import { compactionSummaryMessage, createCompactionEntry } from '../src/resilience/compaction.js'
import { COMPACTED, WRAP, mark, marked } from '../src/core/marks.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WS = resolve(__dirname, '.spore-dir-workspace')

const writeTranscript = (entries) => writeTranscriptEntries(WS, entries)
const said = (message, at = '2026-09-08T00:00:00.000Z') => ({ at, kind: 'message', role: message.role, message })
const compacted = (entry) => ({ at: entry.ts, kind: 'compaction', message: entry })

beforeEach(() => {
  rmSync(WS, { recursive: true, force: true })
  mkdirSync(WS, { recursive: true })
})

afterEach(() => {
  releaseLock(WS)
  rmSync(WS, { recursive: true, force: true })
})

// A lock is only a lock across processes, so the ones that matter are asserted with
// a real second process rather than a file written to look like one.
const SPORE_DIR = pathToFileURL(resolve(__dirname, '../src/core/spore-dir.js')).href
async function holdLockElsewhere (ws) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireLock } from ${JSON.stringify(SPORE_DIR)}
    const taken = acquireLock(${JSON.stringify(ws)})
    process.stdout.write(taken.error ? 'refused: ' + taken.error : 'held')
    setInterval(() => {}, 60000)
  `], { stdio: ['ignore', 'pipe', 'inherit'] })
  const [chunk] = await once(child.stdout, 'data')
  if (chunk.toString() !== 'held') {
    child.kill('SIGKILL')
    throw new Error(chunk.toString())
  }
  return child
}

describe('layout', () => {
  it('keeps the runtime files at the workspace root, undotted', () => {
    expect(definitionPath(WS)).toBe(resolve(WS, 'spore.cmk'))
    expect(lockPath(WS)).toBe(resolve(WS, 'lock'))
    expect(statePath(WS)).toBe(resolve(WS, 'state.sqlite'))
    expect(dataDir(WS)).toBe(resolve(WS, 'data'))
  })

  it('grants the agent every directory it writes, and nothing at the root', () => {
    expect(writableDirs(WS)).toEqual([
      resolve(WS, 'data'), resolve(WS, 'calls'), resolve(WS, 'precursors'), resolve(WS, 'home')
    ])
    expect(writableDirs(WS)).not.toContain(WS)
  })
})

describe('readTranscript', () => {
  it('is empty for a workspace that never ran', () => {
    expect(readTranscript(WS)).toEqual([])
  })

  // An entry carries the wire message and spore's own facts beside it, so what is replayed is
  // exactly what a model can be sent.
  it('replays the message and leaves the time beside it', () => {
    writeTranscript([
      said({ role: 'user', content: 'hello' }, '2026-09-08T00:00:00.000Z'),
      said({ role: 'assistant', content: 'hi' }, '2026-09-08T00:00:01.000Z')
    ])
    expect(readTranscript(WS)).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' }
    ])
  })

  it('writes what it reads back, marks included', () => {
    appendTranscript(WS, { role: 'user', content: 'asked' })
    appendTranscript(WS, mark({ role: 'user', content: '[System: this turn has reached its rounds limit]' }, WRAP))
    const [asked, wrap] = readTranscript(WS)
    expect(asked).toEqual({ role: 'user', content: 'asked' })
    expect(marked(asked, WRAP)).toBe(false)
    expect(marked(wrap, WRAP)).toBe(true)
    const raw = readTranscriptEntries(WS)
    expect(raw[1]).toMatchObject({ kind: 'message', role: 'user', message: { role: 'user' }, marks: ['wrap'] })
    expect(raw[0].marks).toBeNull()
  })

  it('collapses a compacted head instead of replaying it', () => {
    writeTranscript([
      said({ role: 'user', content: 'old one' }),
      said({ role: 'assistant', content: 'old two' }),
      said({ role: 'user', content: 'kept' }),
      compacted(createCompactionEntry('they discussed old things', 2)),
      said({ role: 'assistant', content: 'after' })
    ])
    const replayed = readTranscript(WS)
    expect(replayed).toEqual([
      compactionSummaryMessage('they discussed old things'),
      { role: 'user', content: 'kept' },
      { role: 'assistant', content: 'after' }
    ])
    expect(marked(replayed[0], COMPACTED)).toBe(true)
  })

  it('refuses an entry that is neither a message nor a compaction entry', () => {
    expect(() => writeTranscript([{ at: 'then', kind: 'gossip', message: { role: 'user', content: 'x' } }])).toThrow()
    expect(readTranscript(WS)).toEqual([])
  })

  // v2 has no way to truncate or unlink a transcript and v3 should not either: the store
  // reads what has left the context, so a caller that cleared the file to bound an agent's
  // replay took that source of evidence away from every run it did. Bounding what replays
  // is a compaction entry, which is append-only.
  it('offers no way to shorten the record', async () => {
    const dir = await import('../src/core/spore-dir.js')
    expect(dir.clearTranscript).toBeUndefined()
  })
})

describe('lock', () => {
  it('records the holder and clears on release', () => {
    const taken = acquireLock(WS)
    expect(taken.error).toBeUndefined()
    expect(readLock(WS).pid).toBe(process.pid)
    releaseLock(WS)
    expect(readLock(WS)).toBe(null)
  })

  it('releases without unlinking, since the root goes read-only mid-run', () => {
    acquireLock(WS)
    releaseLock(WS)
    expect(readLock(WS)).toBe(null)
    expect(existsSync(lockPath(WS))).toBe(true)
  })

  it('releasing twice is a no-op, so a signal handler and the exit path may both run', () => {
    acquireLock(WS)
    releaseLock(WS)
    expect(() => releaseLock(WS)).not.toThrow()
  })

  it('refuses a workspace another process is holding', async () => {
    const holder = await holdLockElsewhere(WS)
    try {
      expect(acquireLock(WS).error).toMatch(/already running — pid \d+/)
      expect(readLock(WS).pid).toBe(holder.pid)
    } finally {
      holder.kill('SIGKILL')
      await once(holder, 'exit')
    }
  })

  // The reason to hold the lock in the kernel rather than in the file: SIGKILL runs
  // no handler, so nothing this process wrote gets cleaned up, and the next run still
  // finds the workspace free.
  it('lets the next run in when the holder was killed, and keeps the crash legible', async () => {
    const holder = await holdLockElsewhere(WS)
    holder.kill('SIGKILL')
    await once(holder, 'exit')

    // Still there, un-truncated: a pid left with nobody holding the lock is how a crash
    // is told from a clean exit, and the kernel releasing the lock does not touch it.
    expect(readLock(WS).pid).toBe(holder.pid)

    const taken = acquireLock(WS)
    expect(taken.error).toBeUndefined()
    expect(readLock(WS).pid).toBe(process.pid)
  })

  it('takes over a lock whose holder is gone, which is what a crash leaves', () => {
    writeFileSync(lockPath(WS), JSON.stringify({ pid: 2147483646, startedAt: '2026-09-08T00:00:00.000Z' }))
    const taken = acquireLock(WS)
    expect(taken.error).toBeUndefined()
    expect(readLock(WS).pid).toBe(process.pid)
  })

  // The old read-check-write refused this, because content was the only evidence it
  // had. Nobody holds the lock, so nobody is running, so a half-written file is
  // something to replace rather than a reason to stop.
  it('overwrites a lock file it cannot parse, when nothing holds the lock', () => {
    writeFileSync(lockPath(WS), 'not json')
    expect(acquireLock(WS).error).toBeUndefined()
    expect(readLock(WS).pid).toBe(process.pid)
  })

  it('still refuses when the holder is live and its lock file is garbage', async () => {
    const holder = await holdLockElsewhere(WS)
    try {
      writeFileSync(lockPath(WS), 'not json')
      // The flock already answered the question; telling the caller to delete a file
      // belonging to a running process would be worse than saying less.
      expect(acquireLock(WS).error).toBe('workspace is already running — another process holds the lock')
    } finally {
      holder.kill('SIGKILL')
      await once(holder, 'exit')
    }
  })
})

describe('trail retention', () => {
  const run = (id) => {
    mkdirSync(resolve(WS, 'calls', id, '0001'), { recursive: true })
    writeCall(WS, id, '0001', { tool: 'exec', startedAt: new Date().toISOString() })
    appendEvents(WS, [{ v: 1, at: new Date().toISOString(), runId: id, event: 'round' }])
  }

  it('drops all but the newest, counting the turn about to run', () => {
    for (const id of ['old', 'mid', 'new']) run(id)
    // retain: 2 leaves room for one existing turn plus the one starting now.
    expect(pruneTrail(WS, 2).sort()).toEqual(['mid', 'old'])
    expect(readdirSync(resolve(WS, 'calls'))).toEqual(['new'])
    expect(callRuns(WS)).toEqual(['new'])
    expect(readEvents(WS).map(e => e.runId)).toEqual(['new'])
  })

  it('counts a run with no recorded call as the oldest', () => {
    run('recorded')
    mkdirSync(resolve(WS, 'calls', 'unrecorded', '0001'), { recursive: true })
    expect(pruneTrail(WS, 2)).toEqual(['unrecorded'])
    expect(readdirSync(resolve(WS, 'calls'))).toEqual(['recorded'])
  })

  it('keeps everything when there is room', () => {
    run('only')
    expect(pruneTrail(WS, 10)).toEqual([])
    expect(readdirSync(resolve(WS, 'calls'))).toEqual(['only'])
  })

  it('says nothing has to go when a workspace has never run', () => {
    rmSync(resolve(WS, 'calls'), { recursive: true, force: true })
    expect(pruneTrail(WS, 3)).toEqual([])
  })
})
