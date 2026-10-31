/**
 * A console for the relay (`@rhizogrip/spore/relay`): a chat whose other end is a program. Each
 * person the console file maps is a conversation keyed by the id the host chose for them; what the
 * relay does there is written to the console's event log, which the program reads back by `seq`.
 */

import { statSync } from 'node:fs'

import { SporeError } from '@rhizogrip/spore'
import { commandOf, listenOf as listening } from '@rhizogrip/spore/relay'

const FIELDS = ['listen', 'token', 'people']
const PERSON = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/
const SHAPE = '{ "token": "${LAB_CONSOLE_TOKEN}", "people": { "<person>": "<spore>" } }' // eslint-disable-line no-template-curly-in-string

const invalid = (path, problem, detail = `a console is ${SHAPE}`) => new SporeError(`${path} ${problem}`, { type: 'CONSOLE_BOT_INVALID', detail })

export const isPerson = (id) => typeof id === 'string' && PERSON.test(id)

/** Where the service listens, 127.0.0.1:8790 unless the console file says. */
export const listenOf = (raw, path) => listening(raw.listen, { port: 8790, refused: (problem, detail) => invalid(path, problem, detail) })

/**
 * The console's people, each by the id the host chose for them against the spore they reach —
 * `"<spore>"` or `{ "spore", "details", "brief" }`. A console has no conversation many people share.
 */
const CONVERSATIONS = {
  people: {
    noun: 'person',
    id: PERSON,
    says: 'which is not a person\'s id',
    fix: 'a person is an id of letters, digits, ., _, @ and -, at most 128',
    called: 'their id',
    fields: ['spore', 'details', 'brief']
  }
}

const HELP = 'Anything said to me as a person goes to their spore. /status says what it is doing; /stop ends the turn it is running and sets aside what was sent that it had not read; /wrap [10m] asks it to wrap up; /flush starts the conversation over, forgetting nothing'
const EXTEND = '/extend wall 30m gives it more, as far as its spore.cmk allows'

export const CONSOLE = {
  kind: 'console',
  label: 'console',
  noun: 'conversation',
  fields: FIELDS,
  credentials: ['token'],
  stateFields: [],
  refusals: ['CONSOLE_LISTEN_REFUSED'],
  example: SHAPE,
  conversations: CONVERSATIONS,
  check: listenOf,
  usage: { help: `${HELP}; ${EXTEND}.`, briefHelp: `${HELP}.`, extend: '/extend wall 30m, /extend cost 1.50 or /extend rounds 20' },
  limits: { message: 1_000_000, file: Infinity, fetch: 25 * 1024 * 1024, editEveryMs: 1000, typingEveryMs: 0 },
  can: { upload: true, edit: true, remove: true, react: false, typing: false, choose: true, fields: { text: true } },
  reactions: null,
  showShared: 'working',
  hint (err, { file }) {
    if (err.type === 'CONSOLE_LISTEN_REFUSED') return `another process holds that address — change listen in ${file}`
    return null
  },
  refusal: () => null
}

/** What a person said, as the relay takes a message: `files` are the bytes the request carried, which the log does not keep. */
export function messageOf (name, event, files) {
  return {
    id: `${name}:${event.id}`,
    conversation: event.person,
    message: String(event.seq),
    person: { id: event.person, name: event.person, groups: [], zone: null },
    spore: null,
    where: `the console "${name}"`,
    shared: false,
    text: event.text,
    command: commandOf(event.text),
    addresses: null,
    files: files.map(file => ({ name: file.name, mime: file.mime, bytes: file.data.length, ref: file.data })),
    ...(event.traceparent ? { traceparent: event.traceparent } : {})
  }
}

const keyed = ({ native, fallback }) => native === null ? { default: fallback } : { console: native }

/**
 * The live adapter over the event log. `receive({ deliver, press, signal, log })` is the transport
 * — the HTTP listener, or a test's: `deliver({ event, files })` hands a message the log holds to
 * the relay, and `press({ card, choice, by, inputs })` a press on a card, answering
 * `{ text, taken }`, as the relay acknowledged it. A note is the `seq` of the event that posted it.
 */
export function createAdapter ({ name, events, receive }) {
  return {
    ...CONSOLE,

    listen: ({ onMessage, onChoice, trace, signal, log }) => receive({
      signal,
      log,
      deliver: async ({ event, files }) => {
        trace(`message ${event.id}`, event)
        await onMessage(messageOf(name, event, files))
        events.delivered(event.id)
      },
      press: async ({ card, choice, by, inputs }) => {
        trace(`press on ${card.approval}`, { choice, by, inputs })
        let heard = null
        await onChoice({
          conversation: card.person,
          data: `ap:${card.approval}:${choice}`,
          inputs,
          person: { id: by, name: by, groups: [] },
          acknowledge: async (text, how) => { heard = { text, taken: how?.taken === true } }
        })
        return heard
      }
    }),

    post: async (conversation, text, { answering = null, for: about = [], as = null, turn, origin } = {}) => {
      if (turn) {
        const answers = answering === null ? [] : events.answering(conversation, Number(answering))
        return String(events.append(conversation, turn.stopReason === 'question' ? 'question' : 'reply', { spore: as, text, answers, turn, origin }).seq)
      }
      if (about.length) return String(events.append(conversation, 'working', { spore: as, text, for: about }).seq)
      return String(events.append(conversation, 'notice', { spore: as, text }).seq)
    },

    edit: async (conversation, note, text) => {
      events.append(conversation, 'working', { note: Number(note), text })
    },

    remove: async (conversation, note) => {
      events.append(conversation, 'working', { note: Number(note), removed: true })
    },

    upload: async (conversation, { path, mime }, caption, { as }) => {
      events.append(conversation, 'file', { spore: as, name: caption, mime, bytes: statSync(path).size })
    },

    fetch: async (ref, { most }) => {
      if (ref.length > most) throw new SporeError('the file is larger than this console takes', { type: 'FILE_TOO_LARGE', detail: `more than ${most} bytes`, context: { bytes: ref.length } })
      return ref
    },

    checkBody: () => null,

    ask: async (conversation, shown, choices, { as, fields, approval }) => {
      const card = {
        body: keyed(shown),
        options: choices.map(({ id, label, style, skip }) => ({ id, label, style: style ?? null, skip: skip === true })),
        fields,
        by: approval.by,
        until: approval.until
      }
      const { seq } = events.append(conversation, 'card', { approval: approval.id, spore: as, ...card })
      return { note: String(seq), shown: card }
    },

    settle: async (conversation, note, replacement, { ended }) => {
      const closed = {
        note: Number(note),
        state: ended.state,
        choice: ended.choice,
        by: ended.by,
        outcome: ended.outcome,
        reason: ended.reason,
        ...(replacement.shown ? { closing: replacement.outcome } : { body: keyed(replacement) })
      }
      events.append(conversation, 'closed', { approval: ended.approval, ...closed })
      return closed
    },

    quiet: async (conversation, { turnNo, origin }) => {
      events.append(conversation, 'quiet', { turn: { turnNo, stopReason: 'quiet' }, origin })
    }
  }
}
