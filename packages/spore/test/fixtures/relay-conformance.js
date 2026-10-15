/**
 * What every chat connector promises, as one suite. A connector's service test runs it with a
 * harness — its fake platform behind the interface below — against real spores: runners, the
 * agent, confinement and the records are real, and the model's replies are scripted.
 *
 * harness:
 *   spec                                   the adapter's description
 *   credentials                            { <variable>: <value> } its bot files name, the first bot's first
 *   botFile(bot, table)                    a bot file for { <conversation>: { spore, details } }
 *   platform()                             a fresh fake platform
 *   adapter(platform, bot)                 the live adapter over it
 *   say(platform, { conversation, text, files, id })
 *                                          a person writes there, `id` repeating an earlier delivery;
 *                                          answers { id, message, from }: the delivery's id, the
 *                                          platform's id for what was said, and the `from` the spore
 *                                          should be told
 *   seen(platform, conversation)           what was done there, in order: { op: 'post', note, text,
 *                                          answering, formatted }, { op: 'edit', note, text },
 *                                          { op: 'remove', note }, { op: 'upload', path, caption };
 *                                          `formatted` says the platform was asked to render Markdown
 *   fail(platform, op, error, times)       make `post`, `edit`, `remove` or `upload` fail
 *   retryable(retryAfter), refused(detail) the platform's errors
 *   command(verb, args)                    what a person types for a command
 *
 * `platformTests(ctx)` adds the connector's own cases inside the same setup.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { createModelServer } from './model-server.js'
import { answers, calls, scriptedMo } from './scripted-model.js'
import { outsideRoot } from './outside-ws.js'
import { brokerSocketPath } from '../../src/infra/broker-socket.js'
import { definitionWith } from '../../src/core/identity-defaults.js'
import { outbox, readInbox, readLock, readTurns, statePath as databaseOf } from '../../src/core/spore-dir.js'
import { CONFIG_FILE } from '../../src/library/config.js'
import { send } from '../../src/core/send.js'
import { RUNNING, stateOf, stop } from '../../src/core/state.js'
import { createRelay } from '../../src/relay/index.js'

const WORKING = /^(working…|heard you — still working…)/

export function conformance (harness, platformTests = () => {}) {
  const { spec } = harness
  const otherVariable = Object.keys(harness.credentials)[1]
  let root
  let ws
  let configFile
  let saved
  let broker
  let reply
  let platform
  let logs
  let env
  let release
  let tests = 0
  const running = []

  const until = async (done, limitMs = 15000) => {
    const deadline = Date.now() + limitMs
    while (!done()) {
      if (Date.now() > deadline) throw new Error('waited too long')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  const idle = (turns) => until(() => readTurns(ws).length === turns && stateOf(ws).state !== RUNNING)

  const start = (opts = {}) => {
    const controller = new AbortController()
    const relay = createRelay({
      adapter: harness.adapter(platform, 'triage'),
      botFile: join(root, spec.kind, 'triage.json'),
      statePath: saved,
      env,
      log: (line) => logs.push(line),
      configFile,
      sleep: () => new Promise(resolve => setTimeout(resolve, 5)),
      editEveryMs: 50,
      followEveryMs: 100,
      ...opts
    })
    const done = relay.run(controller.signal)
    const handle = { done, stop: async () => { controller.abort(); await done } }
    running.push(handle)
    return handle
  }

  const routes = (table, other = {}) => {
    mkdirSync(join(root, spec.kind), { recursive: true })
    writeFileSync(join(root, spec.kind, 'triage.json'), JSON.stringify(harness.botFile('triage', table)))
    writeFileSync(join(root, spec.kind, 'other.json'), JSON.stringify(harness.botFile('other', other)))
  }
  const defaultReplyTo = (conversation) => {
    mkdirSync(dirname(CONFIG_FILE), { recursive: true })
    writeFileSync(CONFIG_FILE, JSON.stringify({ replyTo: { triage: `${spec.kind}:triage/${conversation}` } }))
  }
  const savedState = () => (existsSync(saved) ? JSON.parse(readFileSync(saved, 'utf8')) : { cursors: {}, pending: {} })
  const say = (what) => harness.say(platform, what)
  const seen = (conversation) => harness.seen(platform, conversation)
  const posts = (conversation) => seen(conversation).filter(one => one.op === 'post')
  const notes = (conversation) => posts(conversation).filter(one => WORKING.test(one.text))
  const posted = (conversation, text) => posts(conversation).some(one => one.text === text)
  const lastText = (conversation, note) => seen(conversation).filter(one => one.note === note && 'text' in one).at(-1).text

  const ctx = {
    get root () { return root },
    get ws () { return ws },
    get platform () { return platform },
    get env () { return env },
    get logs () { return logs },
    replying: (fn) => { reply = fn },
    start,
    routes,
    until,
    idle,
    say,
    seen,
    posts,
    posted,
    savedState
  }

  describe(`the ${spec.kind} connector`, () => {
    beforeEach(async () => {
      root = outsideRoot(`${spec.kind}-relay`)
      const home = join(root, 'home')
      ws = join(home, 'triage')
      mkdirSync(ws, { recursive: true })
      writeFileSync(join(ws, 'spore.cmk'), definitionWith('anthropic/claude-haiku-4-5'))
      configFile = join(root, 'config.json')
      writeFileSync(configFile, JSON.stringify({ home }))
      saved = join(root, 'state', `${spec.kind}.json`)
      routes({ 1: { spore: 'triage' } })
      logs = []
      release = null
      platform = harness.platform()
      reply = async () => answers('hello back')
      tests += 1
      broker = createModelServer({ mo: scriptedMo((input, round, options) => reply(input, round, options)), socketPath: brokerSocketPath(`${spec.kind}-relay-${tests}`), limit: 10 })
      await broker.listen()
      env = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        XDG_STATE_HOME: process.env.XDG_STATE_HOME,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        SPORE_MODEL_SOCKET: broker.socketPath,
        ...harness.credentials
      }
    })

    afterEach(async () => {
      const test = { root, ws, broker }
      release?.()
      await Promise.allSettled(running.splice(0).map(handle => handle.stop()))
      if (stateOf(test.ws).state === RUNNING) stop(test.ws)
      await until(() => stateOf(test.ws).state !== RUNNING, 20_000)
      await test.broker.close()
      rmSync(test.root, { recursive: true, force: true })
      rmSync(CONFIG_FILE, { force: true })
    }, 30_000)

    describe('a message', () => {
      it('is answered in a new message replying to it, its working message removed, by a runner that holds no credential', async () => {
        let environ = null
        reply = async () => {
          environ = readFileSync(`/proc/${readLock(ws).pid}/environ`, 'utf8')
          return answers('hello back')
        }
        start()
        const asked = say({ conversation: '1', text: 'hello' })

        await until(() => posted('1', 'hello back'))
        const [note] = notes('1')
        expect(posts('1').find(one => one.text === 'hello back').answering).toBe(asked.message)
        await until(() => seen('1').some(one => one.op === 'remove' && one.note === note.note))
        expect(environ).toContain('SPORE_MODEL_SOCKET=')
        for (const variable of Object.keys(harness.credentials)) expect(environ).not.toContain(variable)
      })

      it('is answered in the platform\'s formatting, while what the relay says itself stays plain', async () => {
        reply = async () => answers('**done**, see `report.md`')
        start()
        say({ conversation: '1', text: 'hello' })
        await until(() => posts('1').some(one => one.answering !== null && !WORKING.test(one.text)))
        expect(posts('1').find(one => one.answering !== null && !WORKING.test(one.text)).formatted).toBe(true)
        expect(notes('1')[0].formatted).toBe(false)
      })

      it('reaches the spore with who wrote it and where', async () => {
        start()
        const asked = say({ conversation: '1', text: 'hello' })
        await until(() => posted('1', 'hello back'))
        expect(readInbox(ws)[0]).toMatchObject({ text: 'hello', fromName: asked.from.name, fromId: asked.from.id, fromWhere: asked.from.where })
      })

      it('reaches its turn with a key added to the environment file after the service started, and never a credential', async () => {
        let environ = null
        reply = async () => {
          environ = readFileSync(`/proc/${readLock(ws).pid}/environ`, 'utf8')
          return answers('hello back')
        }
        start()
        writeFileSync(join(root, 'environment'), `LATE_KEY=added-after\n${otherVariable}=from-the-file\n`)
        say({ conversation: '1', text: 'hello' })

        await until(() => posted('1', 'hello back'))
        expect(environ).toContain('LATE_KEY=added-after')
        expect(environ).not.toContain(otherVariable)
      })

      it('never gets an earlier answer for a turn that has none', async () => {
        reply = async (input, round) => (round === 0 ? answers('first') : calls('quiet', { because: 'nothing new' }))
        start()
        say({ conversation: '1', text: 'one' })
        await until(() => posted('1', 'first'))
        await idle(1)

        const second = say({ conversation: '1', text: 'two' })
        await idle(2)
        await until(() => posts('1').some(one => one.answering === second.message))
        expect(posts('1').find(one => one.answering === second.message).text).toMatch(/^no answer · /)
      })

      it('is taken once when the platform hands it over twice', async () => {
        start()
        const asked = say({ conversation: '1', text: 'hello' })
        say({ conversation: '1', text: 'hello', id: asked.id })
        await until(() => posted('1', 'hello back'))
        await idle(1)
        expect(readInbox(ws)).toHaveLength(1)
        expect(notes('1')).toHaveLength(1)
      })

      it('that the spore refuses is told there', async () => {
        start()
        say({ conversation: '1', text: 'hello' })
        await idle(1)
        chmodSync(databaseOf(ws), 0o444)
        try {
          say({ conversation: '1', text: 'again' })
          await until(() => posts('1').some(one => /^not delivered — /.test(one.text)))
          expect(logs.some(line => /INBOX_UNWRITABLE/.test(line))).toBe(true)
        } finally {
          chmodSync(databaseOf(ws), 0o644)
        }
      })

      it('from a conversation nobody allowed gets silence, and the log says how to allow it', async () => {
        start()
        say({ conversation: '99', text: 'hello' })
        await until(() => logs.some(line => line.startsWith('refused') && line.includes('99')))
        expect(seen('99')).toEqual([])
        expect(readInbox(ws)).toEqual([])
      })

      it('with no text is told that only text reaches a spore, and one with files that they did not go', async () => {
        start()
        say({ conversation: '1', text: null, files: 1 })
        await until(() => posted('1', 'only text reaches a spore for now'))
        expect(readInbox(ws)).toEqual([])

        say({ conversation: '1', text: 'what is in this', files: 1 })
        await until(() => posted('1', 'only text reaches a spore for now: your file did not reach triage'))
        await until(() => posted('1', 'hello back'))
        expect(readInbox(ws).map(entry => entry.text)).toEqual(['what is in this'])
      })

      it('shows a conversation that asked for details the command itself, and no other', async () => {
        routes({ 1: { spore: 'triage', details: true }, 2: { spore: 'triage' } })
        reply = async (input, round) => round === 0
          ? calls('wsexec', { command: 'echo checked > data/check.txt', out: 'data/log.txt' })
          : answers('checked')
        start()
        say({ conversation: '1', text: 'check' })
        await until(() => posted('1', 'checked'))
        expect(seen('1').some(one => one.op === 'edit' && one.text.includes('· running echo checked > data/check.txt'))).toBe(true)
      })

      it('shows the tools at work, and hands back what the turn put in data/out', async () => {
        reply = async (input, round) => round === 0
          ? calls('wsexec', { command: 'mkdir -p data/out && echo report > data/out/report.md && echo done', out: 'data/log.txt' })
          : answers('wrote it')
        start()
        say({ conversation: '1', text: 'write me a report' })
        await until(() => seen('1').some(one => one.op === 'upload'))

        const [note] = notes('1')
        expect(seen('1').some(one => one.op === 'edit' && one.note === note.note && one.text.includes('· running a command'))).toBe(true)
        expect(seen('1').some(one => one.text?.includes('mkdir'))).toBe(false)
        expect(posted('1', 'wrote it')).toBe(true)
        expect(seen('1').find(one => one.op === 'upload')).toMatchObject({ path: join(ws, 'data/out/report.md'), caption: 'data/out/report.md' })
      })

      it('says how many files it did not hand back, past the cap', async () => {
        reply = async (input, round) => round === 0
          ? calls('wsexec', { command: 'mkdir -p data/out && for i in $(seq 52); do echo $i > data/out/f$i.txt; done', out: 'data/log.txt' })
          : answers('wrote them')
        start()
        say({ conversation: '1', text: 'write them all' })
        await until(() => posted('1', "and 2 more files in data/out/, in the spore's workspace"))
        expect(seen('1').filter(one => one.op === 'upload')).toHaveLength(50)
      })
    })

    describe('delivering', () => {
      it('waits out a rate limit', async () => {
        const waited = []
        harness.fail(platform, 'post', harness.retryable(1))
        start({ sleep: (ms) => { waited.push(ms); return new Promise(resolve => setTimeout(resolve, 5)) } })
        say({ conversation: '1', text: 'one' })
        await until(() => posted('1', 'hello back'))
        expect(waited).toContain(1000)
      })

      it('marks a working message answered when the platform will not remove it', async () => {
        harness.fail(platform, 'remove', harness.refused('message can\'t be deleted'))
        start()
        say({ conversation: '1', text: 'one' })
        await until(() => posted('1', 'hello back'))
        const [note] = notes('1')
        await until(() => lastText('1', note.note) === 'answered below')
        expect(logs.some(line => /not removed/.test(line))).toBe(true)
      })
    })

    describe('turns nobody in a conversation started', () => {
      it('reach the spore\'s default conversation alone when a schedule fires, and nothing when the turn is quiet', async () => {
        routes({ 1: { spore: 'triage' }, 2: { spore: 'triage' } })
        defaultReplyTo('1')
        reply = async (input, round) => (round === 0 ? answers('two new papers') : calls('quiet', { because: 'no change' }))
        start()
        await until(() => savedState().cursors[ws])

        send(ws, 'Check.', { schedule: { name: 'digest', due: '2026-09-28T07:00:00Z' }, env })
        await until(() => posted('1', 'schedule "digest"\n\ntwo new papers'))

        send(ws, 'Check again.', { schedule: { name: 'digest', due: '2026-09-28T08:00:00Z' }, env })
        await idle(2)
        await until(() => savedState().cursors[ws].turn === 2)
        expect(seen('1')).toHaveLength(1)
        expect(seen('2')).toEqual([])
        expect(outbox(ws).map(entry => [entry.recipient, entry.state])).toEqual([[`${spec.kind}:triage/1`, 'delivered']])
      })

      it('reach no conversation when a terminal asked, since the terminal follows the turn itself', async () => {
        defaultReplyTo('1')
        start()
        await until(() => savedState().cursors[ws])

        send(ws, 'from a terminal', { replyTo: 'terminal', env })
        await idle(1)
        await until(() => savedState().cursors[ws].turn === 1)
        expect(seen('1')).toEqual([])
      })

      it('are refused for a conversation that does not reach the spore, and for one the platform will not take', async () => {
        defaultReplyTo('3')
        start()
        await until(() => savedState().cursors[ws])

        send(ws, 'Check.', { schedule: { name: 'digest', due: '2026-09-28T07:00:00Z' }, env })
        await until(() => outbox(ws).some(entry => entry.state === 'refused'))
        expect(outbox(ws)[0].reason).toMatch(new RegExp(`^${spec.noun} 3 does not reach this spore`))
        expect(seen('3')).toEqual([])
        await idle(1)

        defaultReplyTo('1')
        harness.fail(platform, 'post', harness.refused('Forbidden: bot was blocked by the user'))
        send(ws, 'Check again.', { schedule: { name: 'digest', due: '2026-09-28T08:00:00Z' }, env })
        await until(() => outbox(ws).filter(entry => entry.state === 'refused').length === 2)
        expect(outbox(ws)[1].reason).toMatch(/blocked/)
      })
    })

    describe('a restart', () => {
      it('in the middle of a turn still answers', async () => {
        const gate = new Promise(resolve => { release = resolve })
        reply = async () => { await gate; return answers('late answer') }
        const first = start()
        const asked = say({ conversation: '1', text: 'take your time' })
        await until(() => savedState().pending[ws]?.[0]?.note)
        await first.stop()

        start()
        release()
        await until(() => posted('1', 'late answer'))
        expect(posts('1').find(one => one.text === 'late answer').answering).toBe(asked.message)
        await until(() => Object.keys(savedState().pending).length === 0)
      })

      it('posts a turn that ended while the service was down', async () => {
        defaultReplyTo('1')
        const first = start()
        await until(() => savedState().cursors[ws])
        await first.stop()

        reply = async () => answers('done while you were away')
        send(ws, 'from a terminal', { env })
        await idle(1)

        start()
        await until(() => posted('1', 'sent from elsewhere\n\ndone while you were away'))
      })

      it('posts again, saying it may repeat itself, an answer it was posting when it stopped', async () => {
        defaultReplyTo('1')
        const first = start()
        await until(() => savedState().cursors[ws])
        await first.stop()

        reply = async () => answers('done while you were away')
        send(ws, 'from a terminal', { env })
        await idle(1)

        harness.fail(platform, 'post', harness.retryable(1))
        const posting = start({ sleep: (ms, signal) => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })) })
        await until(() => outbox(ws)[0].attemptedAt !== null)
        await posting.stop()
        expect(outbox(ws)[0].state).toBe('pending')

        start()
        await until(() => posted('1', '(this may repeat an earlier message)\n\nsent from elsewhere\n\ndone while you were away'))
        await until(() => outbox(ws)[0].state === 'delivered')
      })
    })

    describe('commands', () => {
      it('say what the spore is doing, stop only what is running, and say what they are', async () => {
        start()
        say({ conversation: '1', text: harness.command('status') })
        say({ conversation: '1', text: harness.command('stop') })
        say({ conversation: '1', text: harness.command('help') })
        await until(() => posts('1').length === 3)
        expect(posts('1')[0].text).toMatch(/^spore · anthropic\/claude-haiku-4-5\nidle · 0 turns · \$0\.0000/)
        expect(posts('1')[1].text).toBe('nothing is running')
        expect(posts('1')[2].text).toBe(spec.usage.help)
        expect(readInbox(ws)).toEqual([])
      })

      it('change the running turn\'s limits, and say why when nothing changes', async () => {
        start()
        say({ conversation: '1', text: harness.command('wrap') })
        say({ conversation: '1', text: harness.command('extend', 'wall 30m') })
        say({ conversation: '1', text: harness.command('extend') })
        say({ conversation: '1', text: harness.command('extend', 'time 1h') })
        await until(() => posts('1').length === 4)
        expect(posts('1').map(one => one.text)).toEqual([
          'nothing is running',
          'nothing is running',
          spec.usage.extend,
          'a turn\'s limits are rounds, cost, wall, not "time" — as spore extend <name> wall 30m'
        ])
        expect(readInbox(ws)).toEqual([])
      })
    })

    platformTests(ctx)
  })
}
