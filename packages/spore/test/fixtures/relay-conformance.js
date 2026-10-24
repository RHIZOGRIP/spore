/**
 * What every chat connector promises, as one suite. A connector's service test runs it with a
 * harness — its fake platform behind the interface below — against real spores: runners, the
 * agent, confinement and the records are real, and the model's replies are scripted.
 *
 * harness:
 *   spec                                   the adapter's description
 *   credentials                            { <variable>: <value> } its bot files name, the first bot's first;
 *                                          none reaches a turn's runner, its spore granting no plugin
 *   botFile(bot, table, fields)            a bot file for { <conversation>: { spore, details, show, brief,
 *                                          shared, people } } — `shared` a conversation many people
 *                                          share, whose `people`, left out, are everyone and, by id,
 *                                          whoever `say` writes as there unless told — with the bot's
 *                                          other `fields` (`react`, `brief`)
 *   shared(n)                              the id of the nth conversation many people share — left out
 *                                          where the platform has none
 *   platform()                             a fresh fake platform
 *   adapter(platform, bot, botFile)        the live adapter over it
 *   words(text)                            the person's words in what the spore was given for them
 *   formats                                whether the platform has a formatted mode beside a plain one
 *   replyInPrivate                         false where, in a conversation with one person, an answer is
 *                                          a plain new message rather than a reply to the question
 *   say(platform, { conversation, text, files, id, shared, person })
 *                                          a person writes there, to the spore, `files` sent with
 *                                          it as [{ name, mime, data }], `id` repeating an
 *                                          earlier delivery, `shared` in a conversation many people
 *                                          share, `person` their id there; answers
 *                                          { id, message, from }: the delivery's id, the platform's id
 *                                          for what was said, and the `from` the spore should be told
 *   seen(platform, conversation)           what was done there, in order: { op: 'post', note, text,
 *                                          answering, formatted }, { op: 'edit', note, text },
 *                                          { op: 'remove', note }, { op: 'upload', path, caption },
 *                                          { op: 'react', message, emoji }, { op: 'typing' },
 *                                          { op: 'ask', note, text, choices: [{ label, data, style }], fields },
 *                                          { op: 'close', note, text }; `formatted` says the platform
 *                                          was asked to render Markdown, an approval's `text` is
 *                                          what the platform was given to show, as text, and its
 *                                          `fields`, where `spec.can.fields`, what it shows to fill
 *                                          in: [{ id, label, value, required }]
 *   press(platform, { conversation, note, data, person, inputs })
 *                                          where `spec.can.choose`: `person` presses the button
 *                                          carrying `data` on the question `note`, having filled in
 *                                          `inputs`, { <field id>: <text> }; answers
 *                                          { acknowledged() }, what the platform showed them once
 *                                          the press was answered — { text } — or undefined before
 *   fail(platform, op, error, times)       make `post`, `edit`, `remove`, `upload` or `fetch` fail
 *   retryable(retryAfter), refused(detail) the platform's errors
 *   command(verb, args)                    what a person types for a command
 *
 * `platformTests(ctx)` adds the connector's own cases inside the same setup.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'

import { createModelServer } from './model-server.js'
import { answers, calls, scriptedMo } from './scripted-model.js'
import { outsideRoot } from './outside-ws.js'
import { brokerSocketPath } from '../../src/infra/broker-socket.js'
import { definitionWith } from '../../src/core/identity-defaults.js'
import { answerApproval, approvalOf, outbox, readInbox, readLock, readTurns, saidOf, statePath as databaseOf } from '../../src/core/spore-dir.js'
import { CONFIG_FILE } from '../../src/library/config.js'
import { requestApproval } from '../../src/library/verbs.js'
import { send } from '../../src/core/send.js'
import { RUNNING, stateOf, stop } from '../../src/core/state.js'
import { createRelay } from '../../src/relay/index.js'

const WORKING = /^(working…|heard you — still working…)/

export function conformance (harness, platformTests = () => {}) {
  const { spec } = harness
  const namesStrangers = spec.refusal({ conversation: '99', person: { id: '99', name: 'U99', username: 'u99', groups: [] } }, 'bot.json') !== null
  const otherVariable = Object.keys(harness.credentials)[1]
  const replyOf = (asked) => harness.replyInPrivate === false ? null : asked.message
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
  let shaping
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
      adapter: shaping(harness.adapter(platform, 'triage', join(root, spec.kind, 'triage.json'))),
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
      shaping = (adapter) => adapter
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
        expect(posts('1').find(one => one.text === 'hello back').answering).toBe(replyOf(asked))
        await until(() => seen('1').some(one => one.op === 'remove' && one.note === note.note))
        expect(environ).toContain('SPORE_MODEL_SOCKET=')
        for (const variable of Object.keys(harness.credentials)) expect(environ).not.toContain(variable)
      })

      it.runIf(harness.formats)('is answered in the platform\'s formatting, while what the relay says itself stays plain', async () => {
        reply = async () => answers('**done**, see `report.md`')
        start()
        say({ conversation: '1', text: 'hello' })
        const answer = (one) => !WORKING.test(one.text) && (harness.replyInPrivate === false || one.answering !== null)
        await until(() => posts('1').some(answer))
        expect(posts('1').find(answer).formatted).toBe(true)
        expect(notes('1')[0].formatted).toBe(false)
      })

      it('reaches the spore with who wrote it and where', async () => {
        start()
        const asked = say({ conversation: '1', text: 'hello' })
        await until(() => posted('1', 'hello back'))
        const where = spec.can.upload ? asked.from.where : `${asked.from.where}, which gets no files`
        expect(readInbox(ws)[0]).toMatchObject({ fromName: asked.from.name, fromId: asked.from.id, fromWhere: where })
        expect(harness.words(readInbox(ws)[0].text)).toBe('hello')
      })

      it('reaches the spore under the trace the platform carried it with', async () => {
        const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
        shaping = (adapter) => ({ ...adapter, listen: (given) => adapter.listen({ ...given, onMessage: (message) => given.onMessage({ ...message, traceparent }) }) })
        start()
        say({ conversation: '1', text: 'hello' })
        await until(() => posted('1', 'hello back'))
        expect(readInbox(ws)[0].traceparent).toBe(traceparent)
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
        if (harness.replyInPrivate === false) {
          await until(() => posts('1').some(one => /^no answer · /.test(one.text)))
          expect(posts('1').filter(one => one.text === 'first')).toHaveLength(1)
          return
        }
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

      it('with neither text nor a file is told what reaches a spore', async () => {
        start()
        say({ conversation: '1', text: null })
        await until(() => posted('1', 'only text and files reach a spore'))
        expect(readInbox(ws)).toEqual([])
      })

      it('shows a conversation that asked for details the command itself, and no other', async () => {
        routes({ 1: { spore: 'triage', details: true }, 2: { spore: 'triage' } })
        const shown = () => seen('1').some(one => one.op === 'edit' && one.text.includes('· running echo checked > data/check.txt'))
        reply = async (input, round) => {
          if (round === 0) return calls('wsexec', { command: 'echo checked > data/check.txt', out: 'data/log.txt' })
          await until(shown)
          return answers('checked')
        }
        start()
        say({ conversation: '1', text: 'check' })
        await until(() => posted('1', 'checked'))
        expect(shown()).toBe(true)
      })

      it('shows the tools at work, and hands back what the turn put in data/out', async () => {
        const shown = () => seen('1').some(one => one.op === 'edit' && one.note === notes('1')[0].note && one.text.includes('· running a command'))
        reply = async (input, round) => {
          if (round === 0) return calls('wsexec', { command: 'mkdir -p data/out && echo report > data/out/report.md && echo done', out: 'data/log.txt' })
          await until(shown)
          return answers('wrote it')
        }
        start()
        say({ conversation: '1', text: 'write me a report' })
        const handed = spec.can.upload ? (one) => one.op === 'upload' : (one) => one.op === 'post' && one.text === 'data/out/report.md is in the spore\'s workspace'
        await until(() => seen('1').some(handed))

        expect(shown()).toBe(true)
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
        expect(posts('1').find(one => one.text === 'hello back').answering).toBe(replyOf(asked))
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

      it.runIf(harness.shared)('is how a conversation many people share shows a turn by default, or as its entry says', async () => {
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

    describe('files', () => {
      const file = (name, text, mime = 'text/plain') => ({ name, mime, data: Buffer.from(text) })
      const kept = (entry) => entry.files.map(one => ({ name: one.name, bytes: one.bytes, read: one.path === null ? null : readFileSync(join(ws, one.path), 'utf8'), missing: one.missing ?? null }))

      it('reach the spore with what was said, each under its name, fetched by the bot', async () => {
        start()
        say({ conversation: '1', text: 'what is in this', files: [file('report.txt', 'q3 numbers')] })
        await until(() => posted('1', 'hello back'))
        const [entry] = readInbox(ws)
        expect(harness.words(entry.text)).toBe('what is in this')
        expect(kept(entry)).toEqual([{ name: 'report.txt', bytes: 10, read: 'q3 numbers', missing: null }])
        expect(entry.files[0].path).toMatch(/^inbox\.d\/[^/]+\/report\.txt$/)
      })

      it('reach the spore on their own, with nothing written, and two of one name are both kept', async () => {
        start()
        say({ conversation: '1', text: null, files: [file('image.png', 'first'), file('image.png', 'second')] })
        await until(() => posted('1', 'hello back'))
        const [entry] = readInbox(ws)
        expect(readInbox(ws)).toHaveLength(1)
        expect(kept(entry).map(one => one.read)).toEqual(['first', 'second'])
        expect(entry.files.map(one => one.path.split('/').pop())).toEqual(['image.png', 'image-2.png'])
      })

      it('over what the bot takes are told to the person and to the spore, and the rest still go', async () => {
        routes({ 1: { spore: 'triage' } }, {}, { files: '1KB' })
        start()
        say({ conversation: '1', text: 'both', files: [file('small.txt', 'fits'), file('big.bin', 'x'.repeat(2048), 'application/octet-stream')] })
        await until(() => posted('1', 'hello back'))
        expect(posts('1').some(one => /^big\.bin did not reach the spore: (2\.0KB, )?over the 1KB this bot takes$/.test(one.text))).toBe(true)
        const [entry] = readInbox(ws)
        const [small, big] = kept(entry)
        expect(small).toEqual({ name: 'small.txt', bytes: 4, read: 'fits', missing: null })
        expect(big).toMatchObject({ name: 'big.bin', read: null, missing: expect.stringMatching(/over the 1KB this bot takes$/) })
        expect([2048, null]).toContain(big.bytes)
        expect(saidOf(entry)).toMatch(/big\.bin did not come: .*over the 1KB this bot takes\]$/)
      })

      it('the bot takes none of are told so, and what was written still reaches the spore', async () => {
        routes({ 1: { spore: 'triage' } }, {}, { files: false })
        start()
        say({ conversation: '1', text: 'here', files: [file('notes.txt', 'n')] })
        await until(() => posted('1', 'hello back'))
        expect(posted('1', 'notes.txt did not reach the spore: this bot takes no files')).toBe(true)
        expect(readInbox(ws)[0].files[0]).toMatchObject({ path: null, missing: 'this bot takes no files' })
      })

      it('that cannot be fetched are told, and what was written still reaches the spore', async () => {
        harness.fail(platform, 'fetch', harness.refused('Not Found'), 5)
        start()
        say({ conversation: '1', text: 'look', files: [file('gone.txt', 'g')] })
        await until(() => posted('1', 'hello back'))
        expect(posts('1').some(one => one.text.startsWith('gone.txt did not reach the spore: it could not be fetched — '))).toBe(true)
        expect(harness.words(readInbox(ws)[0].text)).toBe('look')
        expect(logs.some(line => line.includes('gone.txt from message'))).toBe(true)
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

      it('is never told where in the workspace a file it was not sent is, and the log is', async () => {
        routes({ 1: { spore: 'triage' } }, {}, { brief: true })
        reply = async (input, round) => round === 0
          ? calls('wsexec', { command: 'mkdir -p data/out && echo report > data/out/report.md', out: 'data/log.txt' })
          : answers('wrote it')
        start()
        say({ conversation: '1', text: 'write me a report' })
        const handed = spec.can.upload
          ? () => seen('1').some(one => one.op === 'upload')
          : () => logs.some(line => /^turn 1: data\/out\/report\.md is in the spore's workspace — not said in .*, which is brief$/.test(line))
        await until(() => posted('1', 'wrote it') && handed())
        expect(posts('1').some(one => /data\//.test(one.text ?? ''))).toBe(false)
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

      it('hand the platform each answer\'s turn and what said it, and an adapter that shows a quiet end the turn nobody asked', async () => {
        const options = []
        const quiets = []
        shaping = (adapter) => ({
          ...adapter,
          post: (conversation, text, given) => {
            options.push(given)
            return adapter.post(conversation, text, given)
          },
          quiet: async (conversation, what) => { quiets.push({ conversation, ...what }) }
        })
        defaultReplyTo('1')
        writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), replyTo: { triage: `${spec.kind}:triage/1` } }))
        reply = async (input, round) => (round === 1 ? calls('quiet', { because: 'no change' }) : answers(round === 0 ? 'two new papers' : 'nothing new'))
        start()
        await until(() => savedState().cursors[ws])

        send(ws, 'Check.', { schedule: { name: 'digest', due: '2026-09-28T07:00:00Z' }, env })
        await until(() => posted('1', 'schedule "digest"\n\ntwo new papers'))
        send(ws, 'Check again.', { schedule: { name: 'digest', due: '2026-09-28T08:00:00Z' }, env })
        await until(() => quiets.length === 1)
        expect(quiets).toEqual([{ conversation: '1', turnNo: 2, origin: 'schedule "digest"' }])

        say({ conversation: '1', text: 'anything new?' })
        await until(() => posted('1', 'nothing new'))
        expect(options.filter(one => one.turn).map(({ turn, origin }) => ({ turn, origin }))).toEqual([
          { turn: { turnNo: 1, stopReason: 'answer' }, origin: 'schedule "digest"' },
          { turn: { turnNo: 3, stopReason: 'answer' }, origin: null }
        ])
        expect(quiets).toHaveLength(1)
      })

      it('reach a brief conversation as the answer alone, and the log with what said it', async () => {
        routes({ 1: { spore: 'triage' } }, {}, { brief: true })
        defaultReplyTo('1')
        reply = async () => answers('tried once more')
        start()
        await until(() => savedState().cursors[ws])

        send(ws, 'Retry.', { schedule: { name: 'retry', due: '2026-09-28T07:00:00Z' }, env })
        await until(() => posted('1', 'tried once more'))
        expect(posts('1').some(one => /retry/.test(one.text ?? ''))).toBe(false)
        expect(logs.some(line => /^turn 1 answered schedule "retry" — not said in .*, which is brief$/.test(line))).toBe(true)
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
        expect(posts('1').find(one => one.text === 'late answer').answering).toBe(replyOf(asked))
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

    describe('an approval', () => {
      const SECRET = 'hook-secret'
      const OPTIONS = [{ id: 'apply', label: 'Apply', style: 'positive' }, { id: 'cancel', label: 'Cancel' }]
      let hook
      let heard
      let answering

      const ask = (request = {}) => requestApproval({
        ws,
        configFile,
        request: { to: `${spec.kind}:triage/1`, by: ['1'], options: OPTIONS, body: { default: { text: 'Apply the new **value**?', facts: [['Now', '82 %']] } }, hook: 'kpi', ...request }
      }).approval
      const approval = (id) => approvalOf(ws, id)
      const questions = (conversation = '1') => seen(conversation).filter(one => one.op === 'ask')
      const closing = (conversation = '1') => seen(conversation).find(one => one.op === 'close')
      const press = (question, label, person, conversation = '1', inputs) =>
        harness.press(platform, { conversation, note: question.note, data: question.choices.find(one => one.label === label).data, person, inputs })
      const acknowledged = async (pressed) => {
        await until(() => pressed.acknowledged() !== undefined)
        return pressed.acknowledged().text
      }

      beforeEach(async () => {
        heard = []
        answering = () => ({ status: 200, body: {} })
        hook = createServer((request, response) => {
          const chunks = []
          request.on('data', chunk => chunks.push(chunk))
          request.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8')
            const expected = createHmac('sha256', SECRET).update(`${request.headers['x-spore-timestamp']}.${raw}`).digest('hex')
            heard.push({ payload: JSON.parse(raw), signed: request.headers['x-spore-signature'] === `sha256=${expected}` })
            const { status, body } = answering(heard.at(-1).payload)
            response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
          })
        })
        await new Promise(resolve => hook.listen(0, '127.0.0.1', resolve))
        const secret = '${KPI_HOOK_SECRET}' // eslint-disable-line no-template-curly-in-string
        writeFileSync(configFile, JSON.stringify({ home: join(root, 'home'), approvals: { kpi: { url: `http://127.0.0.1:${hook.address().port}/hook`, secret } } }))
        env.KPI_HOOK_SECRET = SECRET
      })

      afterEach(() => new Promise(resolve => hook.close(resolve)))

      it.runIf(spec.can.choose)('is posted with its choices, taken from someone it names, the hook told, the question closed, and the spore told once', async () => {
        let environ = null
        reply = async () => {
          environ = readFileSync(`/proc/${readLock(ws).pid}/environ`, 'utf8')
          return answers('noted')
        }
        answering = () => ({ status: 200, body: { tell: '82 % is in' } })
        start({ approveEveryMs: 50 })
        const id = ask()
        await until(() => questions().length === 1)
        const [question] = questions()
        expect(question.choices.map(one => one.label)).toEqual(['Apply', 'Cancel'])
        expect(question.text).toContain('82 %')

        expect(await acknowledged(press(question, 'Apply', '1'))).toBe('Apply — recorded')
        await until(() => posted('1', 'noted'))
        expect(heard).toHaveLength(1)
        expect(heard[0].signed).toBe(true)
        expect(heard[0].payload).toMatchObject({ approval: id, spore: 'triage', place: `${spec.kind}:triage/1`, outcome: 'answered', choice: { id: 'apply', label: 'Apply' }, by: { id: '1', platform: spec.kind } })
        expect(closing().note).toEqual(question.note)
        expect(closing().text).toMatch(/Apply — /)
        expect(approval(id)).toMatchObject({ state: 'answered', choice: 'apply', outcome: 'confirmed', tell: '82 % is in', told: true })
        const told = readInbox(ws).filter(entry => entry.approval === id)
        expect(told).toHaveLength(1)
        expect(told[0]).toMatchObject({ requestId: `approval:${id}`, replyTo: `${spec.kind}:triage/1`, fromId: `${spec.kind}:1` })
        expect(told[0].text).toMatch(/chose "Apply", and the host confirmed it\.\n\nThe host adds:\n82 % is in$/)
        expect(environ).not.toContain('KPI_HOOK_SECRET')
      })

      it.runIf(spec.can.choose)('hands the platform who may answer and until when, which press was taken, and how it ended', async () => {
        const asked = []
        const settled = []
        const acks = []
        shaping = (adapter) => ({
          ...adapter,
          ask: (conversation, shown, choices, options) => {
            asked.push(options)
            return adapter.ask(conversation, shown, choices, options)
          },
          settle: (conversation, note, replacement, options) => {
            settled.push(options)
            return adapter.settle(conversation, note, replacement, options)
          },
          listen: (given) => adapter.listen({
            ...given,
            onChoice: (choice) => given.onChoice({ ...choice, acknowledge: (text, how) => { acks.push([text, how]); return choice.acknowledge(text, how) } })
          })
        })
        start({ approveEveryMs: 50 })
        const id = ask()
        await until(() => questions().length === 1)
        expect(asked).toEqual([{ as: 'triage', fields: [], approval: { id, by: ['1'], until: approval(id).until } }])

        await acknowledged(press(questions()[0], 'Apply', '1'))
        await until(() => approval(id).told)
        await acknowledged(press(questions()[0], 'Cancel', '1'))
        expect(acks).toEqual([['Apply — recorded', { taken: true }], ['this was answered already', undefined]])
        expect(settled).toEqual([{ ended: { approval: id, state: 'answered', choice: 'apply', by: { id: '1', name: approval(id).answererName }, outcome: 'confirmed', reason: null } }])
      })

      it.runIf(spec.can.choose && harness.shared)('takes no press from someone it does not name, none once it is answered, and each on its own approval', async () => {
        const group = harness.shared(5)
        routes({ [group]: { spore: 'triage', shared: true, people: ['41', '42'] } })
        start({ approveEveryMs: 50 })
        const first = ask({ to: `${spec.kind}:triage/${group}`, by: ['41'], hook: undefined })
        const second = ask({ to: `${spec.kind}:triage/${group}`, by: ['41'], hook: undefined })
        await until(() => questions(group).length === 2)
        const [a, b] = questions(group)

        expect(await acknowledged(press(a, 'Apply', '42', group))).toBe('this is not yours to answer')
        expect(await acknowledged(press(b, 'Cancel', '41', group))).toBe('Cancel — recorded')
        await until(() => approval(second).told)
        expect(approval(second)).toMatchObject({ state: 'answered', choice: 'cancel', outcome: null })
        expect(approval(first).state).toBe('posted')
        expect(await acknowledged(press(b, 'Apply', '41', group))).toBe('this was answered already')
        expect(logs.some(line => line.startsWith(`approval ${first} of triage: refused a press by `) && line.includes('(42)'))).toBe(true)
        expect(heard).toEqual([])
      })

      it.runIf(spec.can.choose)('tells the spore it was not confirmed when the hook refuses it', async () => {
        answering = () => ({ status: 409, body: { error: 'stale' } })
        start({ approveEveryMs: 50 })
        const id = ask()
        await until(() => questions().length === 1)
        await acknowledged(press(questions()[0], 'Apply', '1'))
        await until(() => approval(id).told)
        expect(approval(id)).toMatchObject({ outcome: 'failed', reason: expect.stringMatching(/answered 409/) })
        expect(closing().text).toMatch(/not confirmed/)
        expect(readInbox(ws).find(entry => entry.approval === id).text).toMatch(/the host did not confirm it — .*answered 409/)
      })

      it.runIf(spec.can.choose)('expires when nobody answers in time: the question closed, the hook and the spore told', async () => {
        start({ approveEveryMs: 50 })
        const id = ask({ within: '1s' })
        await until(() => approval(id).told)
        expect(approval(id).state).toBe('expired')
        expect(heard.map(one => one.payload.outcome)).toEqual(['expired'])
        expect(closing().text).toMatch(/expired — nobody answered/)
        const told = readInbox(ws).find(entry => entry.approval === id)
        expect(told.fromName).toBe(null)
        expect(told.text).toMatch(/^Nobody answered it by /)
      })

      it('is refused, the hook told, where its conversation does not reach the spore or nothing in it can be shown there', async () => {
        start({ approveEveryMs: 50 })
        const nowhere = ask({ to: `${spec.kind}:triage/2` })
        const unseen = ask({ body: { elsewhere: { html: 'x' } } })
        await until(() => approval(nowhere).settledAt && approval(unseen).settledAt)
        expect(approval(nowhere)).toMatchObject({ state: 'refused', reason: expect.stringMatching(/does not reach this spore/) })
        expect(approval(unseen)).toMatchObject({ state: 'refused', reason: expect.stringMatching(spec.can.choose ? /no body for/ : /cannot ask for an approval yet/) })
        expect(heard.map(one => one.payload.outcome)).toEqual(['refused', 'refused'])
        expect(questions()).toEqual([])
        expect(readInbox(ws).some(entry => entry.approval)).toBe(false)
      })

      it.runIf(spec.can.choose)('is seen through by the next run when the last stopped between the press and its end, the spore told once', async () => {
        answering = () => ({ status: 200, body: { tell: 'applied' } })
        const first = start({ approveEveryMs: 50 })
        const id = ask()
        await until(() => questions().length === 1)
        await first.stop()
        expect(answerApproval(ws, id, { choice: 'apply', inputs: null, person: { id: '1', name: 'U1' } })).toBe(true)
        const second = start({ approveEveryMs: 50 })
        await until(() => approval(id).told)
        await second.stop()
        start({ approveEveryMs: 50 })
        await new Promise(resolve => setTimeout(resolve, 300))
        expect(heard).toHaveLength(1)
        expect(readInbox(ws).filter(entry => entry.approval === id)).toHaveLength(1)
        expect(closing().text).toMatch(/Apply — U1/)
      })

      it.runIf(spec.can.fields)('shows its fields, takes no press without one it requires, and hands on what was filled in', async () => {
        start({ approveEveryMs: 50 })
        const id = ask({ fields: [{ id: 'value', label: 'Value', value: '82 %', required: true }, { id: 'reason', label: 'Why?' }] })
        await until(() => questions().length === 1)
        const [question] = questions()
        expect(question.fields).toEqual([{ id: 'value', label: 'Value', value: '82 %', required: true }, { id: 'reason', label: 'Why?', value: null, required: false }])

        expect(await acknowledged(press(question, 'Apply', '1', '1', { value: ' ', reason: 'checked' }))).toBe('fill in "Value" first')
        expect(approval(id).state).toBe('posted')
        expect(await acknowledged(press(question, 'Apply', '1', '1', { value: '84 %', reason: 'checked' }))).toBe('Apply — recorded')
        await until(() => approval(id).told)
        expect(approval(id).inputs).toEqual({ value: '84 %', reason: 'checked' })
        expect(heard.map(one => one.payload.inputs)).toEqual([{ value: '84 %', reason: 'checked' }])
      })

      it.runIf(spec.can.choose && !spec.can.fields)('is refused where it needs a field this platform cannot show, and posted without those it can go without', async () => {
        start({ approveEveryMs: 50 })
        const needs = ask({ fields: [{ id: 'value', label: 'Value', required: true }, { id: 'reason', label: 'Why?' }] })
        const optional = ask({ fields: [{ id: 'reason', label: 'Why?' }] })
        await until(() => approval(needs).settledAt && questions().length === 1)
        expect(approval(needs)).toMatchObject({ state: 'refused', reason: `a ${spec.label} bot cannot show fields to fill in, and it needs "Value"` })

        expect(await acknowledged(press(questions()[0], 'Apply', '1'))).toBe('Apply — recorded')
        await until(() => approval(optional).told)
        expect(heard.map(one => [one.payload.approval, one.payload.outcome])).toEqual([[needs, 'refused'], [optional, 'answered']])
        expect(heard[1].payload).not.toHaveProperty('inputs')
      })

      it.runIf(spec.can.choose)('leaves the conversation going while it is open: what is said meanwhile is answered, and a press after it still counts', async () => {
        let replies = 0
        reply = async () => answers(++replies === 1 ? 'hello back' : 'noted')
        start({ approveEveryMs: 50 })
        const id = ask()
        await until(() => questions().length === 1)
        say({ conversation: '1', text: 'meanwhile' })
        await until(() => posted('1', 'hello back'))

        expect(await acknowledged(press(questions()[0], 'Apply', '1'))).toBe('Apply — recorded')
        await until(() => posted('1', 'noted'))
        expect(approval(id)).toMatchObject({ state: 'answered', choice: 'apply', told: true })
        const shown = seen('1').filter(one => one.op === 'ask' || one.op === 'close' || (one.op === 'post' && !WORKING.test(one.text)))
        expect(shown.map(one => one.op === 'post' ? one.text : one.op)).toEqual(['ask', 'hello back', 'close', 'noted'])
      })

      it.runIf(spec.can.choose)('is closed with the body the hook answers', async () => {
        answering = () => ({ status: 200, body: { body: { default: { text: 'Done: 82 % is in' } } } })
        start({ approveEveryMs: 50 })
        const id = ask()
        await until(() => questions().length === 1)
        await acknowledged(press(questions()[0], 'Apply', '1'))
        await until(() => approval(id).told)
        expect(closing().text).toContain('Done: 82 % is in')
        expect(closing().text).not.toContain('Apply the new')
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

      it.runIf(harness.shared)('stop, wrap or extend a turn in a conversation many people share only for someone its people name, not everyone "*" lets talk', async () => {
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
