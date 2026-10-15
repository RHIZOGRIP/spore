/**
 * Telegram for the relay (`@rhizogrip/spore/relay`): the bot file it reads, the long poll that
 * hears chats, and the Bot API calls that answer them. A chat is a conversation, keyed by its id;
 * the bot file maps each to the spore it reaches.
 */

import { SporeError } from '@rhizogrip/spore'

import { toHtml } from './format.js'

const COMMAND = /^\/([a-z]+)(@\w+)?(?:\s+(.+))?$/is
const NOT_MODIFIED = /message is not modified/
const CANNOT_PARSE = /can't parse entities/i
const SHAPE = '{ "token": "${TRIAGE_BOT_TOKEN}", "chats": { "<chat id>": "<spore>" } }' // eslint-disable-line no-template-curly-in-string

/** What a bot may react with: `ReactionTypeEmoji` in the Bot API. */
const REACTIONS = [
  '❤', '👍', '👎', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱',
  '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡',
  '🥱', '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡',
  '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈',
  '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈', '😇', '😨',
  '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿',
  '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷‍♂',
  '🤷', '🤷‍♀', '😡'
]

const FIELDS = ['token', 'chats', 'react']
const CHAT_FIELDS = ['spore', 'details', 'show']

const said = (err) => [err.message, err.detail].filter(Boolean).join(' — ')

const invalid = (path, problem, detail) => new SporeError(`${path} ${problem}`, { type: 'TELEGRAM_BOT_INVALID', detail })

/**
 * `{ "<chat id>": "<spore>" }`, or `{ "<chat id>": { "spore": "<spore>", "details": true, "show":
 * "react" } }`: `details` for a chat shown what each call does — its command or path — rather than
 * only what kind of call it is, since a Telegram message leaves the machine; `show` for how a turn
 * shows itself there.
 */
function routes (raw, path) {
  if (typeof raw.chats !== 'object' || raw.chats === null || Array.isArray(raw.chats)) {
    throw invalid(path, 'has no chats', 'chats is { "<chatId>": "<spore>" } — {} while you learn your chat id: the log names every chat it refuses')
  }
  const table = new Map()
  for (const [chat, entry] of Object.entries(raw.chats)) {
    const spore = typeof entry === 'string' ? entry : entry?.spore
    const extra = typeof entry === 'object' && entry !== null ? Object.keys(entry).filter(key => !CHAT_FIELDS.includes(key)) : []
    if (extra.length) {
      const bots = extra.filter(key => FIELDS.includes(key))
      throw invalid(path, `gives chat ${chat} ${extra.join(', ')}, which a chat does not take`, `a chat takes ${CHAT_FIELDS.join(', ')}${bots.length ? `; ${bots.join(', ')} is the bot's, beside chats` : ''}`)
    }
    if (typeof spore !== 'string' || !spore || (typeof entry === 'object' && entry.details !== undefined && typeof entry.details !== 'boolean')) {
      throw invalid(path, `maps ${chat} to something that is not a spore`, 'each chat is a chat id against the name of a spore it may reach, or { "spore": "<name>", "details": true, "show": "react" }')
    }
    table.set(chat, { spores: [spore], details: typeof entry === 'object' && entry.details === true, show: typeof entry === 'object' ? entry.show ?? null : null })
  }
  return table
}

const HELP = 'Anything you write here goes to the spore. /status says what it is doing; /stop ends the turn it is running and sets aside what you sent that it had not read; /wrap [10m] asks it to wrap up; /extend wall 30m gives it more, as far as its spore.cmk allows.'

export const TELEGRAM = {
  kind: 'telegram',
  label: 'Telegram',
  noun: 'chat',
  fields: FIELDS,
  credentials: ['token'],
  stateFields: [],
  sourceVariables: [],
  refusals: ['TELEGRAM_CONFLICT'],
  example: SHAPE,
  routes,
  usage: { help: HELP, extend: '/extend wall 30m, /extend cost 1.50 or /extend rounds 20' },
  limits: { message: 4096, file: 50 * 1024 * 1024, editEveryMs: 2500, typingEveryMs: 4000 },
  can: { upload: true, remove: true, react: true, typing: true },
  reactions: REACTIONS,
  hint (err, { file, bot }) {
    if (err.type === 'TELEGRAM_NO_BOT') {
      const variable = `${bot.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_BOT_TOKEN`
      return `mkdir -p ${file.slice(0, file.lastIndexOf('/'))} && echo '{"token": "$\{${variable}}", "chats": {}}' > ${file}\n  with chats {}, start the bot and message it — the log names every chat it refuses, with its id`
    }
    if (err.type === 'TELEGRAM_FAILED') return `the token comes from @BotFather, in the variable ${file} names`
    if (err.type === 'TELEGRAM_CONFLICT') return 'one bot token is read by one process — stop the other one, or remove its webhook'
    return null
  },
  refusal: (message, botFile) =>
    `refused chat ${message.conversation}${message.person.username ? ` (@${message.person.username})` : ''} — to allow it, add "${message.conversation}": "<a spore>" to the chats of ${botFile}`
}

const FILES = ['photo', 'document', 'video', 'audio', 'voice', 'video_note', 'animation', 'sticker']

export function normalize (update, bot) {
  const message = update.message
  if (message?.chat?.id === undefined) return null
  const text = (message.text ?? message.caption ?? '').trim() || null
  const command = text?.match(COMMAND)
  const { first_name: first, last_name: last, username } = message.from
  return {
    id: `${bot}:${update.update_id}`,
    conversation: String(message.chat.id),
    message: message.message_id,
    person: { id: String(message.from.id), name: `${[first, last].filter(Boolean).join(' ')}${username ? ` (@${username})` : ''}`, username },
    where: message.chat.type === 'private' ? 'a private chat on Telegram' : `the Telegram group "${message.chat.title}"`,
    shared: message.chat.type !== 'private',
    text,
    command: command ? { verb: command[1].toLowerCase(), args: command[3] ?? '' } : null,
    addresses: null,
    files: FILES.filter(kind => message[kind]).length
  }
}

export function createAdapter ({ telegram, bot }) {
  return {
    ...TELEGRAM,

    /**
     * One long poll after another until `signal` aborts. An update is handed to `onMessage` and
     * awaited before the offset moves past it, since moving it is what confirms the update to
     * Telegram: a message is confirmed only once the spore has it.
     */
    async listen ({ onMessage, signal, log, sleep }) {
      let offset
      let backoff = 1000
      while (!signal.aborted) {
        let updates
        try {
          updates = await telegram.updates(offset, { signal })
          backoff = 1000
        } catch (err) {
          if (signal.aborted) break
          if (err.context?.status === 409) {
            throw new SporeError('another process is taking this bot\'s updates', { type: 'TELEGRAM_CONFLICT', detail: err.detail })
          }
          if (!err.retryable) throw err
          log(`poll failed — ${said(err)}`)
          await sleep(err.context?.retryAfter ? err.context.retryAfter * 1000 : backoff)
          backoff = Math.min(backoff * 2, 60_000)
          continue
        }
        for (const update of updates) {
          const message = normalize(update, bot)
          if (message) await onMessage(message)
          offset = update.update_id + 1
        }
      }
      if (offset !== undefined) {
        await telegram.updates(offset, { seconds: 0 }).catch(err => log(`could not confirm the last updates — ${said(err)}`))
      }
    },

    post: async (conversation, text, { answering = null, markdown = false } = {}) => {
      try {
        return (await telegram.say(Number(conversation), markdown ? toHtml(text) : text, { answering, html: markdown })).message_id
      } catch (err) {
        if (!markdown || !CANNOT_PARSE.test(err.detail ?? '')) throw err
        throw new SporeError('Telegram refused the formatting', { type: 'TELEGRAM_FORMAT_REFUSED', detail: err.detail, context: { formatRefused: true } })
      }
    },

    edit: async (conversation, note, text) => {
      try {
        await telegram.revise(Number(conversation), note, text)
      } catch (err) {
        if (!NOT_MODIFIED.test(err.detail ?? '')) throw err
      }
    },

    remove: (conversation, note) => telegram.remove(Number(conversation), note),

    upload: (conversation, file, caption) => telegram.document(Number(conversation), file, caption),

    react: (conversation, message, emoji) => telegram.react(Number(conversation), message, emoji),

    typing: (conversation) => telegram.typing(Number(conversation))
  }
}
