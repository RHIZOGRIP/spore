/**
 * What every chat connector promises, as one suite. A connector's service test runs it with a
 * harness — its fake platform behind the interface below — against real spores: runners, the
 * agent, confinement and the records are real, and the model's replies are scripted.
 *
 * harness:
 *   spec                                   the adapter's description
 *   credentials                            { <variable>: <value> } its bot files name, the first bot's first;
 *                                          none reaches a turn but those the spec's sourceVariables keep
 *   botFile(bot, table, fields)            a bot file for { <conversation>: { spore, details, show, brief,
 *                                          shared, people } } — `shared` a conversation many people
 *                                          share, whose `people`, left out, are everyone and, by id,
 *                                          whoever `say` writes as there unless told — with the bot's
 *                                          other `fields` (`react`, `brief`)
 *   shared(n)                              the id of the nth conversation many people share
 *   platform()                             a fresh fake platform
 *   adapter(platform, bot, botFile)        the live adapter over it
 *   words(text)                            the person's words in what the spore was given for them
 *   formats                                whether the platform has a formatted mode beside a plain one
 *   say(platform, { conversation, text, files, id, shared, person })
 *                                          a person writes there, to the spore, `id` repeating an
 *                                          earlier delivery, `shared` in a conversation many people
 *                                          share, `person` their id there; answers
 *                                          { id, message, from }: the delivery's id, the platform's id
 *                                          for what was said, and the `from` the spore should be told
 *   seen(platform, conversation)           what was done there, in order: { op: 'post', note, text,
 *                                          answering, formatted }, { op: 'edit', note, text },
 *                                          { op: 'remove', note }, { op: 'upload', path, caption },
 *                                          { op: 'react', message, emoji }, { op: 'typing' };
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
  const namesStrangers = spec.refusal({ conversation: '99', person: { id: '99', name: 'U99', username: 'u99', groups: [] } }, 'bot.json') !== null
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

  const until = async (done, limitMs = 15000, state = () => '') => {
    const deadline = Date.now() + limitMs
    while (!done()) {
      if (Date.now() > deadline) throw new Error(`waited too long${state() && ` — ${state()}`}`)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  const idle = (turns, state) => until(() => readTurns(ws).length === turns && stateOf(ws).state !== RUNNING, 15000, state)

  const start = (opts = {}) => {
    const controller = new AbortController()
    const relay = createRelay({
      adapter: harness.adapter(platform, 'triage', join(root, spec.kind, 'triage.json')),
      botFile: join(root, spec.kind, 'triage.json'),
      statePath: saved,
      env,
      log: (line) => logs.push(line),
      configFile,
      sleep: () => new Promise(resolve => setTimeout(resolve, 5)),
      editEveryMs: 50,
      typingEveryMs: 50,
      followEveryMs: 100,
      ...opts
    })
    const done = relay.run(controller.signal)
    const handle = { done, stop: async () => { controller.abort(); await done } }
    running.push(handle)
    return handle
  }

  const routes = (table, other = {}, fields = {}) => {
    mkdirSync(join(root, spec.kind), { recursive: true })
    writeFileSync(join(root, spec.kind, 'triage.json'), JSON.stringify(harness.botFile('triage', table, fields)))
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
    defaultReplyTo,
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
        for (const variable of Object.keys(harness.credentials).filter(name => !spec.sourceVariables.includes(name))) expect(environ).not.toContain(variable)
      })

      it.runIf(harness.formats)('is answered in the platform\'s formatting, while what the relay says itself stays plain', async () => {
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
        expect(readInbox(ws)[0]).toMatchObject({ fromName: asked.from.name, fromId: asked.from.id, fromWhere: asked.from.where })
        expect(harness.words(readInbox(ws)[0].text)).toBe('hello')
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

      it.runIf(namesStrangers)('from a conversation nobody allowed gets silence, and the log says how to allow it', async () => {
        start()
        say({ conversation: '99', text: 'hello' })
        await until(() => logs.some(line => line.startsWith('refused') && line.includes('99')))
        expect(seen('99')).toEqual([])
        expect(readInbox(ws)).toEqual([])
      })

      it.runIf(namesStrangers)('from a conversation nobody allowed is told to the owner once, where answers nobody asked for go', async () => {
        writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), replyTo: { triage: `${spec.kind}:triage/1` } }))
        start()
        say({ conversation: '99', text: 'hello' })
        say({ conversation: '99', text: 'hello again' })
        await until(() => logs.filter(line => line.startsWith('refused') && line.includes('99')).length === 2)
        say({ conversation: '1', text: 'hello' })
        await until(() => posted('1', 'hello back'))
        const hints = posts('1').filter(one => one.text.includes('99'))
        expect(hints).toHaveLength(1)
        expect(hints[0].text).toMatch(/^U99 .* wrote from .*, which .*triage\.json does not name\.\nrefused .*99/)
        expect(seen('99')).toEqual([])
        expect(readInbox(ws).map(entry => harness.words(entry.text))).toEqual(['hello'])
      })

      it('with no text is told that only text reaches a spore, and one with files that they did not go', async () => {
        start()
        say({ conversation: '1', text: null, files: 1 })
        await until(() => posted('1', 'only text reaches a spore for now'))
        expect(readInbox(ws)).toEqual([])

        say({ conversation: '1', text: 'what is in this', files: 1 })
        await until(() => posted('1', 'only text reaches a spore for now: your file did not reach triage'))
        await until(() => posted('1', 'hello back'))
        expect(readInbox(ws).map(entry => harness.words(entry.text))).toEqual(['what is in this'])
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
        const handed = spec.can.upload ? (one) => one.op === 'upload' : (one) => one.op === 'post' && one.text === 'data/out/report.md is in the spore\'s workspace'
        await until(() => seen('1').some(handed))

        const [note] = notes('1')
        expect(seen('1').some(one => one.op === 'edit' && one.note === note.note && one.text.includes('· running a command'))).toBe(true)
        expect(seen('1').some(one => one.text?.includes('mkdir'))).toBe(false)
        expect(posted('1', 'wrote it')).toBe(true)
        if (spec.can.upload) expect(seen('1').find(one => one.op === 'upload')).toMatchObject({ path: join(ws, 'data/out/report.md'), caption: 'data/out/report.md' })
      })

      it('says how many files it did not hand back, past the cap', async () => {
        reply = async (input, round) => round === 0
          ? calls('wsexec', { command: 'mkdir -p data/out && for i in $(seq 52); do echo $i > data/out/f$i.txt; done', out: 'data/log.txt' })
          : answers('wrote them')
        start()
        say({ conversation: '1', text: 'write them all' })
        await until(() => posted('1', "and 2 more files in data/out/, in the spore's workspace"))
        expect(seen('1').filter(one => spec.can.upload ? one.op === 'upload' : / is in the spore's workspace$/.test(one.text ?? ''))).toHaveLength(50)
      })
    })

    describe.runIf(spec.can.react)('a turn shown with a reaction', () => {
      const reactions = (conversation) => seen(conversation).filter(one => one.op === 'react')

      it('is marked taken and typed while it runs, and the mark comes off with the answer', async () => {
        routes({ 1: { spore: 'triage', show: 'react' } })
        const gate = new Promise(resolve => { release = resolve })
        reply = async () => { await gate; return answers('hello back') }
        start()
        const asked = say({ conversation: '1', text: 'hello' })
        await until(() => seen('1').some(one => one.op === 'typing'))
        release()
        await until(() => reactions('1').length === 2)
        expect(reactions('1')).toEqual([{ op: 'react', message: asked.message, emoji: '👨‍💻' }, { op: 'react', message: asked.message, emoji: null }])
        expect(posts('1').find(one => one.text === 'hello back').answering).toBe(asked.message)
        expect(notes('1')).toEqual([])
      })

      it('is marked with the reaction the bot names when the turn ends without an answer, its working message beside it with both', async () => {
        routes({ 1: { spore: 'triage', show: 'both' } }, {}, { react: { failed: '🤷' } })
        reply = async () => calls('quiet', { because: 'nothing new' })
        start()
        say({ conversation: '1', text: 'hello' })
        await until(() => reactions('1').length === 2)
        expect(reactions('1').map(one => one.emoji)).toEqual(['👨‍💻', '🤷'])
        expect(posts('1').some(one => /^no answer · /.test(one.text))).toBe(true)
        expect(notes('1')).toHaveLength(1)
      })

      it('is how a conversation many people share shows a turn by default, or as its entry says', async () => {
        const other = spec.showShared === 'react' ? 'working' : 'react'
        const [seven, eight] = [harness.shared(7), harness.shared(8)]
        routes({ [seven]: { spore: 'triage', shared: true }, [eight]: { spore: 'triage', shared: true, show: other } })
        start()
        const shows = async (conversation, show) => {
          say({ conversation, text: 'hello', shared: true })
          await until(() => posted(conversation, 'hello back'))
          if (show === 'react') {
            await until(() => reactions(conversation).length === 2)
            expect(notes(conversation)).toEqual([])
          } else {
            expect(notes(conversation)).toHaveLength(1)
            expect(reactions(conversation)).toEqual([])
          }
        }
        await shows(seven, spec.showShared)
        await idle(1)
        await shows(eight, other)
      })

      it('marks a message the spore refuses as failed', async () => {
        routes({ 1: { spore: 'triage', show: 'react' } })
        start()
        say({ conversation: '1', text: 'hello' })
        await idle(1)
        chmodSync(databaseOf(ws), 0o444)
        try {
          const refused = say({ conversation: '1', text: 'again' })
          await until(() => reactions('1').some(one => one.message === refused.message))
          expect(reactions('1').filter(one => one.message === refused.message).map(one => one.emoji)).toEqual(['💔'])
        } finally {
          chmodSync(databaseOf(ws), 0o644)
        }
      })
    })

    describe('a brief conversation', () => {
      it('is told the spore is working and that the turn gave no answer, and the log is told how it ended', async () => {
        routes({ 1: { spore: 'triage' } }, {}, { brief: true })
        let asked = 0
        reply = async (input, round) => {
          asked += 1
          return round === 0 ? calls('wsexec', { command: 'sleep 30', out: 'data/sleep.txt' }) : answers('late')
        }
        start()
        say({ conversation: '1', text: 'first' })
        await until(() => asked === 1 && notes('1').length === 1)
        say({ conversation: '1', text: harness.command('status') })
        await until(() => posted('1', 'working'))
        stop(ws)
        await until(() => posted('1', 'no answer this time'))
        expect(posts('1').some(one => /cancelled/.test(one.text))).toBe(false)
        expect(logs.some(line => /^turn 1 ended cancelled.* — not said in .*, which is brief$/.test(line))).toBe(true)
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

      it('drops progress under a rate limit, so the answer is not held behind it', async () => {
        const waited = []
        const gate = new Promise(resolve => { release = resolve })
        harness.fail(platform, 'edit', harness.retryable(30))
        reply = async (input, round) => {
          if (round === 0) return calls('wsexec', { command: 'echo one > data/one.txt', out: 'data/log.txt' })
          await gate
          return answers('done')
        }
        start({ sleep: (ms) => { waited.push(ms); return new Promise(resolve => setTimeout(resolve, 5)) } })
        say({ conversation: '1', text: 'go' })
        await until(() => logs.some(line => /progress dropped/.test(line)))
        release()
        await until(() => posted('1', 'done'))
        expect(waited).not.toContain(30_000)
        expect(seen('1').filter(one => one.op === 'edit' && WORKING.test(one.text))).toEqual([])
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

    describe('stop', () => {
      const where = () => JSON.stringify({
        posts: posts('1').map(one => one.text),
        inbox: readInbox(ws).map(entry => [entry.inboxNo, entry.text, entry.consumed, entry.setAside]),
        turns: readTurns(ws).map(turn => [turn.stopReason, turn.inboxTo]),
        state: stateOf(ws).state,
        err: existsSync(join(ws, 'spore.err')) ? readFileSync(join(ws, 'spore.err'), 'utf8').slice(-1500) : null,
        logs
      })

      const working = () => {
        let asked = 0
        reply = async (input, round) => {
          asked += 1
          return round === 0 ? calls('wsexec', { command: 'sleep 30', out: 'data/sleep.txt' }) : answers('late')
        }
        return () => asked
      }

      it('sets aside what the conversation said that the stopped turn had not read, which no turn then reads or answers', async () => {
        const asked = working()
        start()
        say({ conversation: '1', text: 'first' })
        await until(() => asked() === 1 && notes('1').length === 1)
        say({ conversation: '1', text: 'second' })
        await until(() => notes('1').length === 2)
        say({ conversation: '1', text: harness.command('stop') })
        await until(() => posted('1', 'set aside 1 message you sent that no turn had read'), 15000, where)
        expect(readInbox(ws).map(entry => [harness.words(entry.text), entry.setAside])).toEqual([['first', false], ['second', true]])
        await until(() => posts('1').some(one => /^no answer · cancelled/.test(one.text)), 15000, where)
        const [, waited] = notes('1')
        await until(() => seen('1').some(one => one.op === 'remove' && one.note === waited.note), 15000, where)
        expect(posted('1', 'stopping it')).toBe(true)
        expect(posted('1', 'late')).toBe(false)
        expect(asked()).toBe(1)
      })

      it('sets aside what waited when the turn is stopped during its model call', async () => {
        const gate = new Promise(resolve => { release = resolve })
        let asked = 0
        reply = async () => { asked += 1; await gate; return answers('late') }
        start()
        say({ conversation: '1', text: 'first' })
        await until(() => asked === 1 && notes('1').length === 1)
        say({ conversation: '1', text: 'second' })
        await until(() => notes('1').length === 2)
        say({ conversation: '1', text: harness.command('stop') })
        await until(() => posted('1', 'stopping it'), 15000, where)
        release()
        await until(() => posted('1', 'set aside 1 message you sent that no turn had read'), 15000, where)
        await until(() => posts('1').some(one => /^no answer · cancelled/.test(one.text)), 15000, where)
      })

      it('is written down, having read what it read, when stopped from elsewhere as its model call ends', async () => {
        const gate = new Promise(resolve => { release = resolve })
        let asked = 0
        reply = async () => { asked += 1; await gate; return answers('late') }
        start()
        say({ conversation: '1', text: 'first' })
        await until(() => asked === 1 && notes('1').length === 1)
        say({ conversation: '1', text: 'second' })
        await until(() => notes('1').length === 2)
        stop(ws)
        release()
        await idle(1, where)
        const [turn] = readTurns(ws)
        expect(['cancelled', 'answer']).toContain(turn.stopReason)
        expect(turn.inboxTo).toBe(1)
      })

      it('with nothing running, sets aside what waited for the next turn', async () => {
        const asked = working()
        start()
        say({ conversation: '1', text: 'first' })
        await until(() => asked() === 1 && notes('1').length === 1)
        say({ conversation: '1', text: 'second' })
        await until(() => notes('1').length === 2)
        stop(ws)
        await idle(1, where)
        say({ conversation: '1', text: harness.command('stop') })
        await until(() => posted('1', 'nothing is running — set aside 1 message that waited'), 15000, where)
        expect(readInbox(ws).map(entry => entry.setAside)).toEqual([false, true])
        expect(asked()).toBe(1)
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

      it('stop, wrap or extend a turn in a conversation many people share only for someone its people name, not everyone "*" lets talk', async () => {
        const group = harness.shared(5)
        routes({ [group]: { spore: 'triage', shared: true, people: ['41', '*'] } })
        start()
        const command = (person, verb, args) => say({ conversation: group, text: harness.command(verb, args), shared: true, person })
        command('42', 'stop')
        await until(() => posted(group, `only the people this ${spec.noun} lists may stop a turn`))
        command('42', 'extend', 'wall 30m')
        await until(() => posted(group, `only the people this ${spec.noun} lists may extend a turn`))
        command('42', 'status')
        await until(() => posts(group).some(one => /^spore · /.test(one.text)))
        command('41', 'stop')
        await until(() => posted(group, 'nothing is running'))
        expect(logs.filter(line => /^refused (stop|extend) from .* \(42\) .*add "42" to its people/.test(line))).toHaveLength(2)
        expect(readInbox(ws)).toEqual([])
      })

      it('in a brief conversation say only what state the spore is in, and offer no extend', async () => {
        routes({ 1: { spore: 'triage', brief: false }, 2: { spore: 'triage' } }, {}, { brief: true })
        start()
        say({ conversation: '1', text: harness.command('status') })
        say({ conversation: '2', text: harness.command('status') })
        say({ conversation: '2', text: harness.command('extend', 'wall 30m') })
        say({ conversation: '2', text: harness.command('help') })
        await until(() => posts('1').length === 1 && posts('2').length === 3)
        expect(posts('1')[0].text).toMatch(/^spore · /)
        expect(posts('2').map(one => one.text)).toEqual(['idle', spec.usage.briefHelp, spec.usage.briefHelp])
        expect(spec.usage.briefHelp).not.toMatch(/extend/)
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
