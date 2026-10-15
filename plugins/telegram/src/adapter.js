/**
 * Telegram for the relay (`@rhizogrip/spore/relay`): the bot file it reads, the long poll that
 * hears chats, and the Bot API calls that answer them. A chat is a conversation, keyed by its id:
 * a private chat's is its person's, under `people`, and a group's is negative, under `groups`.
 */

import { SporeError } from '@rhizogrip/spore'

import { toHtml } from './format.js'

const COMMAND = /^\/([a-z]+)(@\w+)?(?:\s+(.+))?$/is
const NOT_MODIFIED = /message is not modified/
const CANNOT_PARSE = /can't parse entities/i
const SHAPE = '{ "token": "${TRIAGE_BOT_TOKEN}", "people": { "<your user id>": "<spore>" }, "groups": { "<group id>": { "spores": ["<spore>"], "people": ["<user id>"] } } }' // eslint-disable-line no-template-curly-in-string
const VERBS = new Set(['status', 'stop', 'wrap', 'extend', 'help'])

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

const FIELDS = ['token', 'people', 'groups', 'react']
const PERSON_FIELDS = ['spore', 'details', 'show']
const GROUP_FIELDS = ['spores', 'people', 'details', 'show', 'overhear']
const PERSON = /^\d+$/
const GROUP = /^-\d+$/

const said = (err) => [err.message, err.detail].filter(Boolean).join(' — ')

const invalid = (path, problem, detail = `a bot is ${SHAPE}`) => new SporeError(`${path} ${problem}`, { type: 'TELEGRAM_BOT_INVALID', detail })

const strays = (path, kind, id, entry, takes) => {
  const extra = Object.keys(entry).filter(key => !takes.includes(key))
  if (!extra.length) return
  const bots = extra.filter(key => FIELDS.includes(key))
  throw invalid(path, `gives ${kind} ${id} ${extra.join(', ')}, which a ${kind} does not take`, `a ${kind} takes ${takes.join(', ')}${bots.length ? `; ${bots.join(', ')} is the bot's, beside people and groups` : ''}`)
}

const flags = (path, kind, id, entry, names) => {
  for (const name of names) {
    if (entry[name] !== undefined && typeof entry[name] !== 'boolean') throw invalid(path, `has a ${kind} ${id} whose ${name} is not true or false`)
  }
}

/**
 * The private chats, `people: { "<person id>": "<spore>" }` or `{ "spore", "details", "show" }`,
 * and the groups, `groups: { "<group id>": { "spores": ["<spore>"], "people": [...], "details",
 * "show", "overhear" } }`. `details` shows a chat what each call does — its command or path — rather
 * than only what kind of call it is, since a Telegram message leaves the machine; `show` how a turn
 * shows itself there. A group names who may address its spore — user ids, or `*` for everyone in it
 * — and has one spore: in a group a bot speaks as itself, so a second spore is a second bot.
 * `overhear` gives the spore what they say there that is not to it.
 */
function routes (raw, path) {
  if (raw.people === undefined && raw.groups === undefined) {
    throw invalid(path, 'has no people and no groups', `a bot is ${SHAPE} — "people": {} while you learn your user id: the log names every chat it refuses`)
  }
  const entries = (field) => {
    const value = raw[field] ?? {}
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(path, `has ${field} that is not { "<id>": … }`)
    return Object.entries(value)
  }
  const table = new Map()
  for (const [person, entry] of entries('people')) {
    if (!PERSON.test(person)) throw invalid(path, `names "${person}" among its people, which is not a person's id`, 'a person\'s id is a positive number; a group\'s is negative, and goes under groups')
    const shaped = typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    if (shaped) {
      strays(path, 'person', person, entry, PERSON_FIELDS)
      flags(path, 'person', person, entry, ['details'])
    }
    const spore = shaped ? entry.spore : entry
    if (typeof spore !== 'string' || !spore) throw invalid(path, `maps person ${person} to something that is not a spore`, 'each person is their id against the name of the spore they reach, or { "spore": "<name>", "details": true, "show": "react" }')
    table.set(person, { spores: [spore], details: shaped && entry.details === true, show: shaped ? entry.show ?? null : null, people: null, overhear: false })
  }
  for (const [group, entry] of entries('groups')) {
    if (!GROUP.test(group)) throw invalid(path, `names "${group}" among its groups, which is not a group's id`, 'a group\'s id is negative (-100… for a supergroup); a person\'s goes under people')
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw invalid(path, `has a group ${group} that is not { "spores": [...], "people": [...] }`)
    strays(path, 'group', group, entry, GROUP_FIELDS)
    flags(path, 'group', group, entry, ['details', 'overhear'])
    if (!Array.isArray(entry.spores) || !entry.spores.length || !entry.spores.every(spore => typeof spore === 'string' && spore)) throw invalid(path, `has a group ${group} with no spores`)
    if (entry.spores.length > 1) throw invalid(path, `gives group ${group} ${entry.spores.length} spores`, 'a bot speaks in a group as itself, so a group has one spore — a second spore there is a second bot')
    if (!Array.isArray(entry.people) || !entry.people.every(who => who === '*' || (typeof who === 'string' && PERSON.test(who)))) {
      throw invalid(path, `has a group ${group} whose people are not user ids or *`, 'people is who may address its spore — ["<user id>", …], or ["*"] for everyone in the group, written out')
    }
    table.set(group, { spores: entry.spores, details: entry.details === true, show: entry.show ?? null, people: entry.people, overhear: entry.overhear === true })
  }
  return table
}

const HELP = 'Anything you write to me in private goes to the spore; in a group, mention me or reply to me. /status says what it is doing; /stop ends the turn it is running and sets aside what you sent that it had not read; /wrap [10m] asks it to wrap up; /extend wall 30m gives it more, as far as its spore.cmk allows.'

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
  can: { upload: true, remove: true, react: true, typing: true, reply: true },
  showShared: 'react',
  reactions: REACTIONS,
  hint (err, { file, bot }) {
    if (err.type === 'TELEGRAM_NO_BOT') {
      const variable = `${bot.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_BOT_TOKEN`
      return `mkdir -p ${file.slice(0, file.lastIndexOf('/'))} && echo '{"token": "$\{${variable}}", "people": {}}' > ${file}\n  with people {}, start the bot and message it — the log names every chat it refuses, with its id`
    }
    if (err.type === 'TELEGRAM_FAILED') return `the token comes from @BotFather, in the variable ${file} names`
    if (err.type === 'TELEGRAM_CONFLICT') return 'one bot token is read by one process — stop the other one, or remove its webhook'
    return null
  },
  refusal: (message, botFile) => message.shared
    ? `refused ${message.where}, chat ${message.conversation} — to allow it, add "${message.conversation}": { "spores": ["<a spore>"], "people": ["${message.person.id}"] } to the groups of ${botFile}`
    : `refused chat ${message.conversation}${message.person.username ? ` (@${message.person.username})` : ''} — to allow it, add "${message.conversation}": "<a spore>" to the people of ${botFile}`
}

const FILES = ['photo', 'document', 'video', 'audio', 'voice', 'video_note', 'animation', 'sticker']

/** Whether the bot's own `@username` is among what Telegram marked as mentions. */
const mentions = (message, me) => {
  const source = message.text ?? message.caption ?? ''
  const own = `@${me.username}`.toLowerCase()
  return (message.entities ?? message.caption_entities ?? [])
    .some(entity => entity.type === 'mention' && source.slice(entity.offset, entity.offset + entity.length).toLowerCase() === own)
}

/**
 * An update as the relay takes it, or null for none it takes: what is not a chat message, and a
 * command naming another bot. In a group, a message reaches the spore when it mentions the bot,
 * replies to one of its messages, or is a command for it — one of the relay's verbs, or one naming
 * this bot; anything else names no spore (`addresses: []`). The bot's mention is not part of what
 * was said to the spore.
 */
export function normalize (update, bot, me) {
  const message = update.message
  if (message?.chat?.id === undefined) return null
  const written = (message.text ?? message.caption ?? '').trim() || null
  const command = written?.match(COMMAND)
  if (command?.[2] && command[2].slice(1).toLowerCase() !== me.username.toLowerCase()) return null
  const shared = message.chat.type !== 'private'
  const addressed = !shared || Boolean(command && (command[2] || VERBS.has(command[1].toLowerCase()))) ||
    mentions(message, me) || message.reply_to_message?.from?.id === me.id
  const text = command ? written : written?.replace(new RegExp(`@${me.username}\\b[,:]?\\s*`, 'gi'), '').trim() || null
  const { first_name: first, last_name: last, username } = message.from
  return {
    id: `${bot}:${update.update_id}`,
    conversation: String(message.chat.id),
    message: message.message_id,
    person: { id: String(message.from.id), name: `${[first, last].filter(Boolean).join(' ')}${username ? ` (@${username})` : ''}`, username, groups: [] },
    spore: null,
    where: shared ? `the Telegram group "${message.chat.title}"` : 'a private chat on Telegram',
    shared,
    text,
    command: command ? { verb: command[1].toLowerCase(), args: command[3] ?? '' } : null,
    addresses: addressed ? null : [],
    files: FILES.filter(kind => message[kind]).length
  }
}

export function createAdapter ({ telegram, bot, me }) {
  return {
    ...TELEGRAM,

    /** Each group that overhears, said when the bot gets only what is addressed to it. */
    prepare: async (table, log) => {
      if (me.can_read_all_group_messages) return
      for (const [group, { overhear }] of table) {
        if (overhear) log(`group ${group} overhears, and @${me.username} gets only what is said to it there: turn its privacy mode off with /setprivacy in @BotFather and add it to the group again, or make it an admin of the group`)
      }
    },

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
          const message = normalize(update, bot, me)
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
