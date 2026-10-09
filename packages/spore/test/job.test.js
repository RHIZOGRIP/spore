import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { superviseJob, deliverJob, jobAlive, progressOf, reportInterrupted } from '../src/core/job.js'
import { beginJob, heldIn, jobsIn, saidOf } from '../src/core/spore-dir.js'
import { definitionWith } from '../src/core/identity-defaults.js'
import { native } from '../src/native.js'

const SUPERVISOR = resolve('bin', 'spore-job.js')

let dir
let ws
let logs
let state

const grant = (lines) => definitionWith('fake/root').replace('\n---\n', `\n${lines}---\n`)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spore-job-'))
  ws = join(dir, 'watcher')
  mkdirSync(join(ws, 'data'), { recursive: true })
  writeFileSync(join(ws, 'spore.cmk'), grant('jobs: [2, 1m]\n'))
  logs = []
  state = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = join(dir, 'state')
})

afterEach(() => {
  if (state === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = state
  rmSync(dir, { recursive: true, force: true })
})

const supervise = (fields = {}) => {
  let answered
  const stopping = new AbortController()
  const ended = superviseJob({
    ws,
    name: 'scan',
    count: 2,
    wallMs: 60_000,
    command: 'true',
    answer: (line) => { answered = line },
    env: { PATH: process.env.PATH },
    envOf: () => ({}),
    signal: stopping.signal,
    releaseHeld: () => ({ released: [], started: false }),
    ...fields
  })
  return { ended, answered: () => answered, stop: () => stopping.abort() }
}

const until = async (check, ms = 5000) => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe('a job', () => {
  it('runs its command, writes only its own directory, and says how it ended', async () => {
    const job = supervise({ command: 'echo found > data/jobs/scan/result; echo listed; echo stray > data/stray; exit 3' })
    await job.ended
    expect(job.answered()).toMatchObject({ name: 'scan', wallMs: 60_000, dir: 'data/jobs/scan' })
    expect(readFileSync(join(ws, 'data', 'jobs', 'scan', 'result'), 'utf8')).toBe('found\n')
    expect(readFileSync(join(ws, 'data', 'jobs', 'scan', 'out'), 'utf8')).toBe('listed\n')
    expect(existsSync(join(ws, 'data', 'stray'))).toBe(false)
    const [row] = jobsIn(ws)
    expect(row).toMatchObject({ name: 'scan', status: 'ended', exit: 3 })
    expect(JSON.parse(readFileSync(join(ws, 'data', 'jobs', 'scan', 'status.json'), 'utf8'))).toMatchObject({ status: 'ended', exit: 3 })
    const [held] = heldIn(ws)
    expect(held.origin).toBe('job:scan')
    const entry = JSON.parse(held.entry)
    expect(entry).toMatchObject({ job: 'scan', jobEvent: 'ended', jobRun: row.run, text: expect.stringMatching(/^The job exited 3 after \d+s\.$/) })
    expect(entry.files.map(file => file.name)).toEqual(['job.json'])
    expect(saidOf(entry)).toMatch(/^\[Sent by job "scan": ended, run /)
    expect(jobAlive(row.run)).toBe(false)
    expect(existsSync(native.jobLockPath(row.run))).toBe(false)
  })

  it('writes a directory the spore writes only when jobs.writes names it, and only reads it otherwise', async () => {
    const proj = join(dir, 'proj')
    mkdirSync(proj)
    writeFileSync(join(proj, 'src'), 'code\n')
    writeFileSync(join(ws, 'spore.cmk'), grant(`writes: [proj=${proj}]\njobs: [2, 1m]\n`))
    const reading = supervise({ command: `cat ${proj}/src; echo built > ${proj}/target` })
    await reading.ended
    expect(readFileSync(join(ws, 'data', 'jobs', 'scan', 'out'), 'utf8')).toBe('code\n')
    expect(existsSync(join(proj, 'target'))).toBe(false)

    writeFileSync(join(ws, 'spore.cmk'), grant(`writes: [proj=${proj}]\njobs: [2, 1m]\njobs.writes: [proj]\n`))
    const building = supervise({ name: 'build', command: `echo built > ${proj}/target` })
    await building.ended
    expect(readFileSync(join(proj, 'target'), 'utf8')).toBe('built\n')
  })

  it('is stopped at its wall, or when its supervisor is asked to stop, with all it started', async () => {
    const walled = supervise({ command: 'sleep 30', wallMs: 1000 })
    await walled.ended
    expect(jobsIn(ws)[0]).toMatchObject({ status: 'walled' })
    expect(JSON.parse(heldIn(ws)[0].entry).text).toMatch(/stopped at its wall, 1s/)

    const stopped = supervise({ name: 'crawl', command: 'setsid sleep 60 & echo $! > data/jobs/crawl/pid; wait' })
    await until(() => existsSync(join(ws, 'data', 'jobs', 'crawl', 'pid')))
    const run = stopped.answered().run
    expect(jobAlive(run)).toBe(true)
    const escaped = Number(readFileSync(join(ws, 'data', 'jobs', 'crawl', 'pid'), 'utf8'))
    stopped.stop()
    await stopped.ended
    expect(jobsIn(ws).find(row => row.run === run)).toMatchObject({ status: 'stopped' })
    await until(() => { try { process.kill(escaped, 0); return false } catch { return true } })
  }, 20_000)

  it('is refused under a name already running, past the grant, and named outside the rule', async () => {
    const first = supervise({ command: 'sleep 30' })
    await until(() => first.answered())
    const again = supervise({ command: 'true' })
    await again.ended
    expect(again.answered().refused).toMatchObject({ type: 'JOB_RUNNING' })
    const other = supervise({ name: 'other', command: 'true', count: 1 })
    await other.ended
    expect(other.answered().refused).toMatchObject({ type: 'JOBS_FULL', detail: 'running: scan' })
    const odd = supervise({ name: '../up', command: 'true' })
    await odd.ended
    expect(odd.answered().refused).toMatchObject({ type: 'JOB_NAME_INVALID' })
    first.stop()
    await first.ended
    expect(jobsIn(ws).map(row => row.name)).toEqual(['scan'])
  })

  it('writes its streams anew, never through a link a run before it left', async () => {
    mkdirSync(join(ws, 'data', 'jobs', 'scan'), { recursive: true })
    writeFileSync(join(dir, 'victim'), 'untouched')
    symlinkSync(join(dir, 'victim'), join(ws, 'data', 'jobs', 'scan', 'out'))
    symlinkSync(join(dir, 'victim'), join(ws, 'data', 'jobs', 'scan', 'status.json'))
    const job = supervise({ command: 'echo listed' })
    await job.ended
    expect(readFileSync(join(dir, 'victim'), 'utf8')).toBe('untouched')
    expect(readFileSync(join(ws, 'data', 'jobs', 'scan', 'out'), 'utf8')).toBe('listed\n')
    expect(JSON.parse(readFileSync(join(ws, 'data', 'jobs', 'scan', 'status.json'), 'utf8'))).toMatchObject({ status: 'ended', exit: 0 })
  })

  it('is refused a directory that leads out of the spore', async () => {
    mkdirSync(join(ws, 'data', 'jobs'), { recursive: true })
    mkdirSync(join(dir, 'outside'))
    symlinkSync(join(dir, 'outside'), join(ws, 'data', 'jobs', 'scan'))
    const job = supervise({ command: 'echo x > data/jobs/scan/x' })
    await job.ended
    expect(job.answered().refused).toMatchObject({ type: 'JOB_DIR_INVALID' })
    expect(existsSync(join(dir, 'outside', 'x'))).toBe(false)
    expect(jobsIn(ws)).toEqual([])
  })
})

describe('while a job runs', () => {
  it('shows the last line of progress it wrote this run, and says what needs attention once what it said before is read', async () => {
    const job = supervise({
      command: [
        'echo "page 1/445" > data/jobs/scan/progress',
        'echo "page 171/445" >> data/jobs/scan/progress',
        'node "$SPORE_JOB" say "half the pages are 404"',
        'sleep 3',
        'node "$SPORE_JOB" say "and more"',
        'node "$SPORE_JOB" say "and the rest"',
        'touch data/jobs/scan/done; sleep 30'
      ].join('; ')
    })
    await until(() => existsSync(join(ws, 'data', 'jobs', 'scan', 'done')), 15_000)
    const [running] = jobsIn(ws, { running: true })
    expect(progressOf(ws, running)).toBe('page 171/445')
    await new Promise(resolve => setTimeout(resolve, 2500))
    const said = heldIn(ws).map(row => JSON.parse(row.entry))
    expect(said).toEqual([expect.objectContaining({ job: 'scan', jobEvent: 'said', text: 'half the pages are 404' })])
    expect(readFileSync(join(ws, 'data', 'jobs', 'scan', 'say'), 'utf8')).toBe('and the rest\n')
    job.stop()
    await job.ended
    expect(progressOf(ws, jobsIn(ws)[0])).toBe(null)
  }, 30_000)

  it('is reported once as interrupted when its supervisor is gone', () => {
    beginJob(ws, { name: 'scan', run: 'r-gone', command: 'sleep 1000', wallMs: 60_000 }, 2)
    expect(reportInterrupted(ws, { env: {}, log: () => {}, releaseHeld: () => ({ released: [], started: false }) }).map(job => job.run)).toEqual(['r-gone'])
    expect(jobsIn(ws)[0]).toMatchObject({ status: 'interrupted' })
    expect(JSON.parse(heldIn(ws)[0].entry)).toMatchObject({ job: 'scan', jobEvent: 'interrupted', jobRun: 'r-gone' })
    expect(reportInterrupted(ws, { env: {}, log: () => {}, releaseHeld: () => { throw new Error('nothing to say twice') } })).toEqual([])
  })
})

describe('what a job says', () => {
  const report = { job: 'scan', run: 'r-1', event: 'ended' }

  it('is routed when the owner bounds its wait and the spore keeps a router for it', async () => {
    writeFileSync(join(ws, 'spore.cmk'), grant('jobs: [2, 1m]\njobs.maxWait: 2h\n'))
    mkdirSync(join(ws, 'data', 'routes'), { recursive: true })
    writeFileSync(join(ws, 'data', 'routes', 'job-scan.route'), '#!/bin/sh\n')
    const asked = []
    await deliverJob(ws, { name: 'scan', run: 'r-1', event: 'ended', ref: 'ended', text: 'The job exited 0 after 3m.', report }, {
      envOf: () => ({}),
      log: (line) => logs.push(line),
      route: async (question) => { asked.push(question); return { wait: 30 * 60_000, summary: 'scan: done, 445 pages', replaces: false } },
      releaseHeld: () => { throw new Error('nothing is due') }
    })
    expect(asked[0]).toMatchObject({ origin: 'job:scan', event: 'ended', ref: 'r-1' })
    expect(JSON.parse(readFileSync(asked[0].payload, 'utf8'))).toEqual(report)
    const [held] = heldIn(ws)
    expect(held).toMatchObject({ origin: 'job:scan', summary: 'scan: done, 445 pages' })
    expect(Date.parse(held.releaseAt) - Date.parse(held.at)).toBeGreaterThan(29 * 60_000)
  })

  it('is said at once without a bound, and kept for the tick when every slot is taken', async () => {
    mkdirSync(join(ws, 'data', 'routes'), { recursive: true })
    writeFileSync(join(ws, 'data', 'routes', 'job-scan.route'), '#!/bin/sh\n')
    const released = []
    await deliverJob(ws, { name: 'scan', run: 'r-1', event: 'ended', ref: 'ended', text: 'The job exited 0 after 3m.', report }, {
      envOf: () => ({}),
      log: (line) => logs.push(line),
      route: async () => { throw new Error('no router is asked without jobs.maxWait') },
      releaseHeld: (at) => { released.push(at); throw Object.assign(new Error('full'), { type: 'ADMISSION_FULL' }) }
    })
    expect(released).toEqual([ws])
    const [held] = heldIn(ws)
    expect(held.releaseAt).toBe(held.deadline)
    expect(logs.join('\n')).toMatch(/every turn slot is taken, the pass releases it once one frees/)
  })
})

describe('while spores are paused', () => {
  it('keeps what a job says held, for the pass after the pause is lifted', async () => {
    await deliverJob(ws, { name: 'scan', run: 'r-9', event: 'ended', ref: 'ended', text: 'The job exited 0 after 3m.', report: { job: 'scan', run: 'r-9', event: 'ended' } }, {
      envOf: () => ({}),
      log: (line) => logs.push(line),
      releaseHeld: () => { throw Object.assign(new Error('your spores are paused'), { type: 'PAUSED' }) }
    })
    expect(heldIn(ws)).toHaveLength(1)
    expect(logs.join('\n')).toMatch(/held — spores are paused, the pass releases it after spore unpause/)
  })
})

describe('the supervisor, as a process', () => {
  it('answers one line, lets go of its stdout, and goes on to the end of the job', async () => {
    writeFileSync(join(ws, 'spore.cmk'), grant('jobs: [2, 1m]\njobs.maxWait: 2h\n'))
    mkdirSync(join(ws, 'data', 'routes'), { recursive: true })
    writeFileSync(join(ws, 'data', 'routes', 'job-scan.route.js'), 'console.log(JSON.stringify({ wait: "1h", summary: "scan ended" }))\n')
    const child = spawn(process.execPath, [SUPERVISOR, '--ws', ws, '--name', 'scan', '--count', '2', '--wall', '60000', '--command', 'echo done > data/jobs/scan/result'], {
      env: { ...process.env, XDG_CONFIG_HOME: join(dir, 'config') },
      stdio: ['ignore', 'pipe', 'inherit']
    })
    let printed = ''
    child.stdout.on('data', chunk => { printed += chunk })
    const [code] = await once(child, 'close')
    expect(code).toBe(0)
    expect(printed.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(printed)).toMatchObject({ name: 'scan', dir: 'data/jobs/scan' })
    expect(readFileSync(join(ws, 'data', 'jobs', 'scan', 'result'), 'utf8')).toBe('done\n')
    expect(heldIn(ws)[0]).toMatchObject({ origin: 'job:scan', summary: 'scan ended' })
    expect(readFileSync(join(ws, 'data', 'jobs', 'scan', 'supervisor.log'), 'utf8')).toMatch(/routed to wait 60m — scan ended/)
  }, 20_000)
})
