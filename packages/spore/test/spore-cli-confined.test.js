/**
 * Two turns of `spore`, confined, in one workspace.
 *
 * The other CLI tests pass `--unsafe`, because a workspace under the repo is inside a
 * path the sandbox grants and the runtime refuses to confine there. So nothing had run
 * the pair of processes as they actually run: Landlock applied, the agent writing only
 * its islands, the lock taken and released, and a second turn replaying the first.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createModelServer } from './fixtures/model-server.js'
import { brokerSocketPath } from '../src/infra/broker-socket.js'
import { outcome } from '../src/library/watch.js'
import { takeSlot } from '../src/core/admission.js'
import { containCheck } from '../src/core/command.js'
import { appendInbox, readEvents, readLock, readTranscript, readTranscriptEntries, readTurns } from '../src/core/spore-dir.js'
import { callRuns, readCalls } from '../src/core/call-record.js'
import { outsideRoot, outsideWorkspace } from './fixtures/outside-ws.js'
import { answers, calls, scriptedMo } from './fixtures/scripted-model.js'

const run = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const SPORE = resolve(__dirname, '../../spore-cli/bin/spore.js')
const RUNNER = resolve(__dirname, '../native/spore-runner')
const CONTAINED = containCheck().contained

let ws
let broker
let mo

// Enough of a PNG for the sniffer; nothing decodes it, and the scripted provider never
// resolves the URI.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120)])

// Every process with a descriptor on the file; one that exits mid-scan is skipped.
const holdersOf = (path) => readdirSync('/proc').filter(p => /^\d+$/.test(p)).filter(pid => {
  try {
    return readdirSync(`/proc/${pid}/fd`).some(fd => {
      try {
        return readlinkSync(`/proc/${pid}/fd/${fd}`) === path
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}).map(Number)

const imageParts = (input) => input
  .flatMap(m => (Array.isArray(m.content) ? m.content : []))
  .filter(part => part?.type === 'image')

const spore = async (prompt, env = {}) => {
  try {
    const { stdout, stderr } = await run(process.execPath, [SPORE, 'send', ws, prompt], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        XDG_STATE_HOME: process.env.XDG_STATE_HOME,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        MODEL: 'anthropic/claude-haiku-4-5',
        SPORE_MODEL_SOCKET: broker.socketPath,
        ...env
      }
    })
    return { code: 0, stdout, stderr }
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr }
  }
}

const start = async (reply) => {
  mo = scriptedMo(reply)
  broker = createModelServer({ mo, socketPath: brokerSocketPath('cli-confined'), limit: 10 })
  await broker.listen()
}

beforeEach(() => {
  ws = outsideWorkspace('spore-cli-confined')
})

afterEach(async () => {
  await broker?.close()
  broker = null
  rmSync(ws, { recursive: true, force: true })
})

describe('a confined turn', () => {
  it('runs, writes its island, and leaves the lock free for the next one', async () => {
    await start(async (input, round) => round === 0
      ? calls('wsexec', { command: 'echo first > data/first.txt && echo done', out: 'data/log.txt' })
      : answers('one'))

    const first = await spore('do the first thing')
    expect(first.code, first.stderr).toBe(0)
    expect(first.stdout.trim()).toBe('one')
    expect(readFileSync(resolve(ws, 'data/first.txt'), 'utf8')).toBe('first\n')

    const [turn] = readTurns(ws)
    expect(turn.stopReason).toBe('answer')
    expect(turn.concluded).toBe(true)
    expect(turn.rounds).toBe(2)

    // Released rather than removed: the file stays, empty, and the next turn takes it.
    expect(readFileSync(resolve(ws, 'lock'), 'utf8')).toBe('')
  })

  it('holds its admission slot in the runner alone, and frees it when the turn ends', async () => {
    const state = outsideRoot('spore-cli-state')
    const dir = resolve(state, 'spore', 'slots')
    const slot = resolve(dir, '0')
    let during = null
    try {
      await start(async (input, round) => {
        if (round > 0) return answers('held')
        during = { holders: holdersOf(realpathSync(slot)), runner: readLock(ws).pid }
        return calls('wsexec', { command: 'sleep 0.2', out: 'data/log.txt' })
      })

      const r = await spore('hold a slot', { XDG_STATE_HOME: state })
      expect(r.code, r.stderr).toBe(0)
      expect(during.holders).toEqual([during.runner])
      expect(holdersOf(realpathSync(slot))).toEqual([])
      closeSync(takeSlot({ turns: 1, dir }).fd)
    } finally {
      rmSync(state, { recursive: true, force: true })
    }
  })

  it('cannot write outside the islands, however it tries', async () => {
    await start(async (input, round) => round === 0
      ? calls('wsexec', { command: 'echo x > escaped.txt', out: 'data/log.txt', err: 'data/why.txt' })
      : answers('blocked'))

    const r = await spore('try to write the root')
    expect(r.code, r.stderr).toBe(0)
    expect(existsSync(resolve(ws, 'escaped.txt'))).toBe(false)
    expect(readFileSync(resolve(ws, 'data/why.txt'), 'utf8')).toMatch(/Permission denied/)
    // The turn record itself sits at that root, which is what makes it evidence.
    expect(readTurns(ws)).toHaveLength(1)
  })

  it('changes the directory it writes in place, and only reads a corpus', async () => {
    const proj = outsideRoot('spore-cli-proj')
    const corpus = outsideRoot('spore-cli-corpus')
    try {
      writeFileSync(resolve(ws, 'spore.cmk'), readFileSync(resolve(ws, 'spore.cmk'), 'utf8')
        .replace(/^---\n/, `---\nwrites: [here=${proj}]\nreads: [papers=${corpus}]\n`))
      const steps = [
        calls('write', { path: 'here/made.txt', content: 'first' }),
        calls('edit', { path: 'here/made.txt', old: 'first', new: 'edited' }),
        calls('wsexec', { command: 'echo shell > here/shell.txt', out: 'data/w.txt' }),
        calls('exec', { command: 'echo exec > here/exec.txt', out: 'data/e.txt', err: 'data/e-err.txt' }),
        calls('write', { path: 'papers/x.txt', content: 'no' }),
        calls('wsexec', { command: 'echo no > papers/shell.txt', out: 'data/p.txt', err: 'data/p-err.txt' })
      ]
      await start(async (input, round) => steps[round] ?? answers('done'))

      const r = await spore('work in here')
      expect(r.code, r.stderr).toBe(0)
      expect(readFileSync(resolve(proj, 'made.txt'), 'utf8')).toBe('edited')
      expect(readFileSync(resolve(proj, 'shell.txt'), 'utf8')).toBe('shell\n')
      expect(existsSync(resolve(proj, 'exec.txt'))).toBe(false)
      expect(readFileSync(resolve(ws, 'data/e-err.txt'), 'utf8')).toMatch(/Permission denied/)
      expect(JSON.stringify(mo.seen[5])).toMatch(/papers\/ is a corpus this spore reads and never writes/)
      expect(existsSync(resolve(corpus, 'x.txt'))).toBe(false)
      expect(existsSync(resolve(corpus, 'shell.txt'))).toBe(false)
      expect(readFileSync(resolve(ws, 'data/p-err.txt'), 'utf8')).toMatch(/Permission denied/)
    } finally {
      rmSync(proj, { recursive: true, force: true })
      rmSync(corpus, { recursive: true, force: true })
    }
  })

  it('refuses the turn when the directory it writes overlaps what it must not write', async () => {
    const corpus = outsideRoot('spore-cli-overlap')
    try {
      mkdirSync(resolve(corpus, 'sub'), { recursive: true })
      writeFileSync(resolve(ws, 'spore.cmk'), readFileSync(resolve(ws, 'spore.cmk'), 'utf8')
        .replace(/^---\n/, `---\nwrites: [here=${resolve(corpus, 'sub')}]\nreads: [papers=${corpus}]\n`))
      await start(async () => answers('never'))

      const r = await spore('work in here')
      expect(r.code).not.toBe(0)
      expect(mo.seen).toHaveLength(0)
      expect(readTurns(ws).at(-1)).toMatchObject({ error: 'START_FAILED', detail: expect.stringMatching(/a corpus it only reads/) })
    } finally {
      rmSync(corpus, { recursive: true, force: true })
    }
  })

  it('refuses the turn when its commands would be handed more paths to read than confine takes', async () => {
    const corpora = outsideRoot('spore-cli-many-reads')
    try {
      const reads = Array.from({ length: 260 }, (_, i) => `c${i}=${resolve(corpora, String(i))}`)
      for (const read of reads) mkdirSync(read.slice(read.indexOf('=') + 1), { recursive: true })
      writeFileSync(resolve(ws, 'spore.cmk'), readFileSync(resolve(ws, 'spore.cmk'), 'utf8')
        .replace(/^---\n/, `---\nreads: [${reads.join(', ')}]\n`))
      await start(async () => answers('never'))

      const r = await spore('read them all')
      expect(r.code).not.toBe(0)
      expect(mo.seen).toHaveLength(0)
      expect(readTurns(ws).at(-1)).toMatchObject({ error: 'START_FAILED', detail: expect.stringMatching(/past the 256 confine takes — 260 it reads/) })
    } finally {
      rmSync(corpora, { recursive: true, force: true })
    }
  })

  it('replays the first turn into the second, and records both', async () => {
    await start(async (input, round) => round === 0
      ? calls('write', { path: 'data/first.txt', content: 'material' })
      : answers(round === 1 ? 'one' : 'two'))

    await spore('do the first thing')
    const second = await spore('now the second')
    expect(second.code, second.stderr).toBe(0)
    expect(second.stdout.trim()).toBe('two')

    // The third model call is the second turn's first round, and it opens with
    // everything the first turn said — that is what "running again continues it" means.
    const resumed = mo.seen[2].map(m => JSON.stringify(m.content)).join('\n')
    expect(resumed).toMatch(/do the first thing/)
    expect(resumed).toMatch(/one/)
    expect(resumed).toMatch(/now the second/)

    const turns = readTurns(ws)
    expect(turns).toHaveLength(2)
    expect(turns.map(t => t.stopReason)).toEqual(['answer', 'answer'])
    // Two turns, one conversation.
    expect(readTranscript(ws).filter(m => m.role === 'user')).toHaveLength(2)
  })

  // The whole argument for carrying an image as a message part rather than as an envelope
  // field is that it replays. An envelope field attaches to one call, so a page looked at
  // on turn one is gone by turn two with only the model's own words about it left.
  it('looks at an image, and the picture is still there on the next turn', async () => {
    mkdirSync(resolve(ws, 'data'), { recursive: true })
    writeFileSync(resolve(ws, 'data/shot.png'), PNG)

    await start(async (input, round) => {
      if (round === 0) return calls('read', { path: 'data/shot.png' })
      if (round === 1) return answers('a red square')
      return answers('still the same square')
    })

    const first = await spore('what is in data/shot.png')
    expect(first.code, first.stderr).toBe(0)
    expect(first.stdout.trim()).toBe('a red square')

    expect(imageParts(mo.seen[1])).toEqual([{ type: 'image', fileUri: `file://${resolve(ws, 'data/shot.png')}`, mimeType: 'image/png' }])

    const second = await spore('and now?')
    expect(second.code, second.stderr).toBe(0)
    expect(imageParts(mo.seen[2])).toHaveLength(1)

    // On disk too, so a third process reading the workspace sees what the model saw.
    const onDisk = readTranscript(ws).flatMap(m => (Array.isArray(m.content) ? m.content : []))
    expect(onDisk.filter(p => p.type === 'image')).toHaveLength(1)
  })

  // Across the broker and into the log: the provider's chunks reach the confined agent as
  // they are produced, and the log records them as a client of that stream.
  it('streams the answer into the event log as it is produced', async () => {
    await start(async (input, round, options) => {
      options.realtimeHandler?.({ type: 'message', delta: 'streamed ' })
      options.realtimeHandler?.({ type: 'message', delta: 'answer' })
      options.realtimeHandler?.({ type: 'function_call', delta: '{"path":' })
      return answers('streamed answer')
    })

    const result = await spore('say something')
    expect(result.code, result.stderr).toBe(0)

    const streamed = readEvents(ws).filter(e => e.event === 'stream').map(e => [e.kind, e.delta])
    expect(streamed).toEqual([['message', 'streamed answer'], ['function_call', '{"path":']])
    const order = readEvents(ws).map(e => e.event)
    expect(order.indexOf('stream')).toBeLessThan(order.indexOf('complete'))
  })

  it('runs its commands behind the host: scheduled after it, killed before it when memory runs out', async () => {
    await start(async (input, round) => round === 0
      ? calls('wsexec', { command: 'cat /proc/self/oom_score_adj > data/standing.txt; nice >> data/standing.txt', out: 'data/log.txt' })
      : answers('measured'))

    const result = await spore('how do your commands run')
    expect(result.code, result.stderr).toBe(0)
    const [oom, nice] = readFileSync(resolve(ws, 'data/standing.txt'), 'utf8').trim().split('\n').map(Number)
    expect(oom).toBeGreaterThanOrEqual(500)
    expect(nice).toBeGreaterThanOrEqual(10)
  })

  it('keeps its channel from every command it runs', async () => {
    const forge = 'printf \'{"id":9,"op":"turn.outcome","turn":{"stopReason":"forged"}}\\n\' >&3'
    await start(async (input, round) => {
      if (round === 0) return calls('exec', { command: forge, out: 'data/exec.txt' })
      if (round === 1) return calls('wsexec', { command: forge, out: 'data/wsexec.txt' })
      return answers('real')
    })

    const result = await spore('try to write the turn record')
    expect(result.code, result.stderr).toBe(0)

    const records = readCalls(ws, callRuns(ws)[0]).map(({ record }) => record)
    expect(records.map(r => r.tool)).toEqual(['exec', 'wsexec'])
    for (const record of records) {
      expect(record.exit).not.toBe(0)
      expect(record.files.err.content).toMatch(/Bad file descriptor/)
    }

    const turns = readTurns(ws)
    expect(turns).toHaveLength(1)
    expect(turns[0].stopReason).toBe('answer')
  })

  it.skipIf(!CONTAINED)('sees the processes of its own turn and no other', async () => {
    const outside = spawn('sleep', ['30.12345'])
    try {
      await start(async (input, round) => round === 0
        ? calls('wsexec', { command: 'for seen in "30[.]12345" "spore-agent[.]js"; do cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\\0" "\\n" | grep -c "$seen"; done', out: 'data/seen.txt' })
        : answers('looked'))
      const result = await spore('look around')
      expect(result.code, result.stderr).toBe(0)
      const [others, own] = readFileSync(resolve(ws, 'data/seen.txt'), 'utf8').trim().split('\n').map(Number)
      expect(others).toBe(0)
      expect(own).toBeGreaterThanOrEqual(1)
    } finally {
      outside.kill()
    }
  })

  it('is refused on a host that cannot contain it, its message left for a turn that can', async () => {
    await start(async () => answers('should not be asked'))
    const result = await spore('hello', { SPORE_CRASH_AT: 'contain-check' })
    expect(result.code).not.toBe(0)
    expect(mo.seen).toHaveLength(0)
    const [turn] = readTurns(ws)
    expect(turn).toMatchObject({ stopReason: 'error', error: 'CONTAIN_FAILED' })
    expect(turn.detail).toMatch(/refused for a test.*spore config set contain off/)
  })

  it('runs uncontained on a host that cannot contain it once the operator turned containment off', async () => {
    const config = resolve(process.env.XDG_CONFIG_HOME, 'spore', 'config.json')
    mkdirSync(dirname(config), { recursive: true })
    writeFileSync(config, JSON.stringify({ contain: false }))
    try {
      await start(async (input, round) => round === 0 ? calls('wsexec', { command: 'unshare -U true', out: 'data/u.txt', err: 'data/u.err' }) : answers('ran'))
      const result = await spore('hello', { SPORE_CRASH_AT: 'contain-check' })
      expect(result.code, result.stderr).toBe(0)
      expect(readTurns(ws)[0].stopReason).toBe('answer')
      expect(readFileSync(resolve(ws, 'data/u.err'), 'utf8')).toMatch(/Operation not permitted/)
    } finally {
      rmSync(config, { force: true })
    }
  })

  it.skipIf(!CONTAINED)('is refused as root, its message left for a turn run as an ordinary user', async () => {
    await start(async () => answers('should not be asked'))
    const asRoot = await run('unshare', ['-r', process.execPath, SPORE, 'send', ws, 'hello'], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_STATE_HOME: process.env.XDG_STATE_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, MODEL: 'anthropic/claude-haiku-4-5', SPORE_MODEL_SOCKET: broker.socketPath }
    }).catch(e => e)
    expect(asRoot.code).not.toBe(0)
    expect(mo.seen).toHaveLength(0)
    expect(readTurns(ws)[0]).toMatchObject({ stopReason: 'error', error: 'ROOT_REFUSED' })
  })

  it('cannot make namespaces of its own, whatever the host allows', async () => {
    await start(async (input, round) => round === 0
      ? calls('wsexec', { command: 'unshare -U true; echo "unshare $?"', out: 'data/unshare.txt', err: 'data/unshare.err' })
      : answers('tried'))
    const result = await spore('try to unshare')
    expect(result.code, result.stderr).toBe(0)
    expect(readFileSync(resolve(ws, 'data/unshare.txt'), 'utf8')).toMatch(/^unshare [1-9]/m)
    expect(readFileSync(resolve(ws, 'data/unshare.err'), 'utf8')).toMatch(/Operation not permitted/)
  })

  it('gives its commands a home of their own, writable, and hands none of it back', async () => {
    await start(async (input, round) => round === 0
      ? calls('wsexec', { command: 'printf %s "$HOME" > data/home.txt && printf "[user]\\n\\temail = spore@example.invalid\\n" > "$HOME/.gitconfig"', out: 'data/log.txt' })
      : answers('set up'))

    const result = await spore('keep your settings')
    expect(result.code, result.stderr).toBe(0)
    expect(readFileSync(resolve(ws, 'data/home.txt'), 'utf8')).toBe(resolve(ws, 'home'))
    expect(readFileSync(resolve(ws, 'home/.gitconfig'), 'utf8')).toContain('spore@example.invalid')
    expect(readTurns(ws)[0].produced.map(file => file.path)).not.toContain('home/.gitconfig')
  })

  it('gives its commands what the runner is told to add to their environment', async () => {
    await start(async (input, round) => round === 0
      ? calls('wsexec', { command: 'printf %s "$FIXTURE_GREETING" > data/env.txt', out: 'data/log.txt' })
      : answers('seen'))
    const slots = outsideRoot('spore-cli-env-slots')
    const slot = takeSlot({ turns: 1, dir: slots })
    appendInbox(ws, 'look')
    try {
      spawn(RUNNER, ['--ws', ws, '--slot', slot.path, '--node', process.execPath], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', slot.fd],
        env: { PATH: process.env.PATH, HOME: process.env.HOME, MODEL: 'anthropic/claude-haiku-4-5', SPORE_MODEL_SOCKET: broker.socketPath, SPORE_PLUGIN_ENV: JSON.stringify({ FIXTURE_GREETING: 'hello = there' }) }
      }).unref()
    } finally {
      closeSync(slot.fd)
    }
    const deadline = Date.now() + 15000
    while (!readTurns(ws).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    rmSync(slots, { recursive: true, force: true })
    expect(readTurns(ws)[0]?.stopReason).toBe('answer')
    expect(readFileSync(resolve(ws, 'data/env.txt'), 'utf8')).toBe('hello = there')
  })

  // Beside the prose, never inside it: the consumer reads a field, not a sentence.
  it('records what the turn left behind, including what no call record names', async () => {
    await start(async (input, round) => round === 0
      ? calls('wsexec', { command: 'mkdir -p data/out && echo report > data/out/report.md && echo scratch > data/notes.txt && echo done', out: 'data/log.txt' })
      : answers('wrote the report'))

    const result = await spore('write me a report')
    expect(result.code, result.stderr).toBe(0)

    const [turn] = readTurns(ws)
    const paths = turn.produced.map(f => f.path)
    // `data/out/report.md` was written by the command, not by a tool, so nothing in the
    // trail mentions it — and it still has to come back.
    expect(paths).toContain('data/out/report.md')
    expect(paths).toContain('data/notes.txt')
    expect(turn.produced[0].path).toBe('data/out/report.md')
    expect(turn.produced[0].delivered).toBe(true)
    expect(turn.produced[0].mime).toBe('text/markdown')

    expect(outcome(ws).produced.map(f => f.path)).toEqual(paths)
  })

  it('refuses to look when the definition grants no images', async () => {
    mkdirSync(resolve(ws, 'data'), { recursive: true })
    writeFileSync(resolve(ws, 'data/shot.png'), PNG)
    writeFileSync(resolve(ws, 'spore.cmk'), readFileSync(resolve(ws, 'spore.cmk'), 'utf8').replace(/^images:.*\n/m, ''))

    await start(async (input, round) => round === 0
      ? calls('read', { path: 'data/shot.png' })
      : answers('I could not look'))

    const result = await spore('what is in data/shot.png')
    expect(result.code, result.stderr).toBe(0)
    expect(imageParts(mo.seen[1])).toHaveLength(0)
    const said = mo.seen[1].map(m => JSON.stringify(m.content)).join('\n')
    expect(said).toMatch(/not granted images/)
  })
})

// The history is weighed by what the provider counted, never by the estimate alone: a transcript
// that reads light can be sent heavy (encrypted reasoning, a provider's own parts), and a bound
// checked against the estimate then never holds. Here the transcript reads under `history`
// while the provider reports far over it, nearly all of it cached.
describe('the history a spore carries', () => {
  it('is summarized at the next turn when the provider counted it past its bound, however light it reads', async () => {
    writeFileSync(resolve(ws, 'spore.cmk'), readFileSync(resolve(ws, 'spore.cmk'), 'utf8').replace(/^---\n/, '---\nhistory: 8000\n'))
    const said = (input) => JSON.stringify(input.at(-1))
    await start(async (input) => {
      if (JSON.stringify(input).includes('Summarize the following conversation history')) return answers('Earlier: a long first answer.')
      if (said(input).includes('gamma-turn')) return { ...answers('three'), inputTokens: 900 }
      if (said(input).includes('beta-turn')) return { ...answers('two'), inputTokens: 1_000, cacheReadInputTokens: 8_000 }
      return answers('one ' + 'y'.repeat(20_000))
    })

    for (const message of ['alpha-turn', 'beta-turn']) expect((await spore(message)).code).toBe(0)
    expect(readTranscriptEntries(ws).some(entry => entry.kind === 'compaction')).toBe(false)

    const third = await spore('gamma-turn')
    expect(third.code, third.stderr).toBe(0)
    expect(readTranscriptEntries(ws).filter(entry => entry.kind === 'compaction')).toHaveLength(1)
    const sent = JSON.stringify(mo.seen.at(-1))
    expect(sent).toContain('Earlier: a long first answer.')
    expect(sent).not.toContain('y'.repeat(100))

    const [, second, last] = readTurns(ws)
    expect(second).toMatchObject({ historySent: 9_000, historyBound: 8_000 })
    expect(last).toMatchObject({ historySent: 900, historyBound: 8_000 })
    expect(readEvents(ws, { event: 'compaction' })).toHaveLength(1)
  })
})
