/**
 * WhatsApp for the relay (`@rhizogrip/spore/relay`), through Meta's Cloud API: the bot file, what
 * Meta's webhook delivers, and the Graph API calls that answer it. A bot is one business phone
 * number; a conversation is a person's chat with it, keyed by their business-scoped user id
 * (`US.13491208655302741918`), the one id every message carries.
 */

import { SporeError } from '@rhizogrip/spore'
import { commandOf, listenOf as listening } from '@rhizogrip/spore/relay'

import { toWhatsApp } from './format.js'

const FIELDS = ['number', 'token', 'secret', 'verify', 'listen', 'people']
const PERSON = /^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/
const NUMBER = /^\d+$/
const WHERE = 'a chat on WhatsApp'
const MEDIA = new Set(['image', 'document', 'audio', 'video', 'sticker'])
const EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/amr': '.amr',
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp'
}
const BUTTONS = { most: 3, label: 20 }
const ROWS = { most: 10, label: 24 }
const BODY_MOST = 1024
const BODY = 'WhatsApp takes no approval body of its own yet — give the approval a default { "text", "facts" }'
const SHAPE = '{ "number": "<phone number id>", "token": "${OPS_WHATSAPP_TOKEN}", "secret": "${OPS_WHATSAPP_SECRET}", "verify": "${OPS_WHATSAPP_VERIFY}", "people": { "<business-scoped user id>": "<spore>" } }' // eslint-disable-line no-template-curly-in-string

const invalid = (path, problem, detail = `a bot is ${SHAPE}`) => new SporeError(`${path} ${problem}`, { type: 'WHATSAPP_BOT_INVALID', detail })

/** Where the service listens, 127.0.0.1:3979 unless the bot file says: a proxy of the operator's gives it the HTTPS callback URL the Meta app names. */
export const listenOf = (raw, path) => listening(raw.listen, { port: 3979, refused: (problem, detail) => invalid(path, problem, detail) })

/**
 * The number the bot is, where it listens, and its `people`: each person's chat with it by their
 * business-scoped user id — `"<spore>"` or `{ "spore", "brief" }`. A turn shows itself by
 * reaction and typing, WhatsApp letting no business edit what it sent.
 */
const CONVERSATIONS = {
  people: {
    noun: 'person',
    id: PERSON,
    says: 'which is not a business-scoped user id',
    fix: 'a person is the business-scoped user id WhatsApp gives them for this number, as US.13491208655302741918 — the log names it when they first write',
    called: 'their business-scoped user id',
    fields: ['spore', 'brief']
  }
}

function check (raw, path) {
  if (typeof raw.number !== 'string' || !NUMBER.test(raw.number)) throw invalid(path, 'has no number', 'number is the phone number id Meta shows under the app\'s WhatsApp API Setup, digits only — not the phone number itself')
  listenOf(raw, path)
}

const HELP = 'Anything you write to me goes to the spore. /status says what it is doing; /stop ends the turn it is running and sets aside what you sent that it had not read; /wrap [10m] asks it to wrap up; /flush starts the conversation over, forgetting nothing'
const EXTEND = '/extend wall 30m gives it more, as far as its spore.cmk allows'

export const WHATSAPP = {
  kind: 'whatsapp',
  label: 'WhatsApp',
  noun: 'chat',
  fields: FIELDS,
  credentials: ['token', 'secret', 'verify'],
  stateFields: ['latest'],
  refusals: ['WHATSAPP_REFUSED', 'WHATSAPP_LISTEN_REFUSED'],
  example: SHAPE,
  conversations: CONVERSATIONS,
  check,
  usage: { help: `${HELP}; ${EXTEND}.`, briefHelp: `${HELP}.`, extend: '/extend wall 30m, /extend cost 1.50 or /extend rounds 20' },
  limits: { message: 4096, file: 100 * 1024 * 1024, fetch: 100 * 1024 * 1024, editEveryMs: 0, typingEveryMs: 20000 },
  can: { upload: true, edit: false, remove: false, react: true, typing: true, choose: true, fields: false },
  reactions: null,
  showShared: 'react',
  hint (err, { file }) {
    if (err.type === 'WHATSAPP_REFUSED') return 'the token is a system user\'s access token with whatsapp_business_messaging and whatsapp_business_management, from the business portfolio that owns the number; it goes in environment beside config.json'
    if (err.type === 'WHATSAPP_LISTEN_REFUSED') return `another process holds that address — change listen in ${file}`
    return null
  },
  refusal: (message, botFile) => `refused ${message.person.name} (${message.person.id}) — to allow them, add "${message.person.id}": "<a spore>" to the people of ${botFile}`
}

const nameOf = (contact, id) => {
  const profile = contact?.profile
  if (!profile?.name) return id
  return `${profile.name}${profile.username ? ` (@${profile.username})` : ''}`
}

const personOf = (id, contacts) => ({ id, name: nameOf(contacts?.find(contact => contact.user_id === id), id), groups: [] })

/** The one file a message carries, under its own name or one made of its kind and Meta's id for it; its media id is what fetches it. */
function filesOf (message) {
  if (!MEDIA.has(message.type)) return []
  const media = message[message.type]
  const mime = media.mime_type?.split(';')[0].trim() ?? null
  const kind = message.type === 'audio' && media.voice ? 'voice' : message.type
  return [{ name: media.filename ?? `${kind}-${media.id}${EXTENSIONS[mime] ?? ''}`, mime, bytes: null, ref: media.id }]
}

/**
 * A message as the relay takes it: its text, or a file's caption. A kind the service does not read
 * — a location, a contact card — reaches the relay with neither text nor a file, which it tells the
 * person.
 */
export function normalize (message, contacts) {
  const said = message.type === 'text' ? message.text.body : MEDIA.has(message.type) ? message[message.type].caption ?? '' : ''
  const text = said.trim() || null
  return {
    id: message.id,
    conversation: message.from_user_id,
    message: message.id,
    person: personOf(message.from_user_id, contacts),
    spore: null,
    where: WHERE,
    shared: false,
    text,
    command: commandOf(text),
    addresses: null,
    files: filesOf(message)
  }
}

/** A press on one of the relay's buttons or list rows, as the relay takes it; null for any other interactive reply. */
export function choiceOf (message, contacts) {
  const reply = message.interactive.button_reply ?? message.interactive.list_reply
  if (!reply) return null
  return {
    conversation: message.from_user_id,
    note: message.context?.id ?? null,
    data: reply.id,
    inputs: null,
    person: personOf(message.from_user_id, contacts),
    where: WHERE
  }
}

const textOf = (body) => ({ type: 'text', text: { body } })

/** An approval's default body in WhatsApp's markup: its text, then each fact on a line. */
const bodyOf = (fallback) => [
  fallback.text ? toWhatsApp(fallback.text) : null,
  fallback.facts?.length ? fallback.facts.map(([label, value]) => `*${label}*: ${value}`).join('\n') : null
].filter(Boolean).join('\n\n')

const cannotAsk = (detail) => new SporeError('WhatsApp cannot show this approval', { type: 'WHATSAPP_ASK_REFUSED', detail, retryable: false })

/** The question as reply buttons where its choices fit them, else as a list; one that fits neither is refused. */
function interactiveOf (body, choices) {
  if (body.length > BODY_MOST) throw cannotAsk(`its text is ${body.length} characters, and WhatsApp shows at most ${BODY_MOST} above buttons`)
  const fits = ({ most, label }) => choices.length <= most && choices.every(choice => choice.label.length <= label)
  if (fits(BUTTONS)) {
    return { type: 'button', body: { text: body }, action: { buttons: choices.map(choice => ({ type: 'reply', reply: { id: choice.data, title: choice.label } })) } }
  }
  if (fits(ROWS)) {
    return { type: 'list', body: { text: body }, action: { button: 'Choose', sections: [{ rows: choices.map(choice => ({ id: choice.data, title: choice.label })) }] } }
  }
  throw cannotAsk(`WhatsApp shows at most ${BUTTONS.most} buttons with labels of ${BUTTONS.label} characters, or a list of ${ROWS.most} with labels of ${ROWS.label}`)
}

/**
 * The live adapter. `receive({ onDelivery, signal, log })` is the transport — the listener, or a
 * test's — and hands over each delivery already checked. A note is the id of the message the bot
 * sent; `latest` keeps each person's last message, which is what WhatsApp shows typing against.
 */
export function createAdapter ({ graph, receive, number }) {
  let kept = null
  let save = null

  const remember = (person, id) => {
    if (kept.latest[person] === id) return
    kept.latest[person] = id
    save()
  }

  const take = async (message, contacts, { onMessage, onChoice, log }) => {
    if (!message.from_user_id) return log(`message ${message.id} carries no business-scoped user id, not taken`)
    if (message.type === 'reaction') return
    if (message.type === 'edit' || message.type === 'revoke') {
      return log(`chat ${message.from_user_id}: ${message.type === 'edit' ? 'an edit' : 'a deletion'} of message ${message[message.type].original_message_id} — the spore keeps what was first said`)
    }
    remember(message.from_user_id, message.id)
    const choice = message.type === 'interactive' ? choiceOf(message, contacts) : null
    if (choice) {
      const acknowledge = async (text) => { if (text) await graph.send(message.from_user_id, textOf(text), message.id) }
      return onChoice({ ...choice, acknowledge })
    }
    await onMessage(normalize(message, contacts))
  }

  /** A message the bot sent that WhatsApp could not deliver after accepting it: said, since the relay has settled it. */
  const failed = (status, log) => {
    const why = status.errors?.map(error => `${error.code} ${error.title}${error.error_data?.details ? ` — ${error.error_data.details}` : ''}`).join('; ')
    log(`chat ${status.recipient_user_id}: message ${status.id} was not delivered${why ? ` (${why})` : ''}`)
  }

  return {
    ...WHATSAPP,

    restore (state, persist) {
      kept = state
      save = persist
    },

    listen: ({ onMessage, onChoice, trace, signal, log }) => receive({
      signal,
      log,
      onDelivery: async (delivery) => {
        for (const entry of delivery.entry) {
          trace(`delivery ${entry.id}`, entry)
          for (const change of entry.changes) {
            if (change.field !== 'messages') continue
            const { metadata, contacts, messages = [], statuses = [] } = change.value
            if (metadata.phone_number_id !== number) {
              log(`dropped a delivery for number ${metadata.phone_number_id}: this bot is ${number}`)
              continue
            }
            for (const status of statuses) if (status.status === 'failed') failed(status, log)
            for (const message of messages) await take(message, contacts, { onMessage, onChoice, log })
          }
        }
      }
    }),

    post: (conversation, text, { answering = null, markdown = false } = {}) =>
      graph.send(conversation, textOf(markdown ? toWhatsApp(text) : text), answering),

    upload: (conversation, file, caption) => graph.document(conversation, { path: file.path, mime: file.mime ?? 'application/octet-stream' }, caption),

    react: (conversation, message, emoji) => graph.react(conversation, message, emoji ?? ''),

    typing: (conversation) => graph.typing(kept.latest[conversation]),

    fetch: (ref, { most }) => graph.download(ref, { most }),

    checkBody: () => BODY,

    ask: async (conversation, { fallback }, choices) => {
      const interactive = interactiveOf(bodyOf(fallback), choices)
      return { note: await graph.send(conversation, { type: 'interactive', interactive }), shown: interactive }
    },

    /** The question closed: its buttons cannot be taken back, so how it ended is a reply to it — the hook's body, or the outcome. */
    settle: async (conversation, note, replacement) => {
      if (replacement.native) throw new SporeError('WhatsApp cannot show this replacement', { type: 'WHATSAPP_ASK_REFUSED', detail: BODY, retryable: false })
      const body = replacement.shown ? `*${replacement.outcome}*` : bodyOf(replacement.fallback)
      await graph.send(conversation, textOf(body), note)
      return { text: body }
    }
  }
}
