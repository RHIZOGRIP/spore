/**
 * Discord for the relay (`@rhizogrip/spore/relay`): the bot file, the Gateway that hears channels,
 * and the webhook each spore speaks through under its own name. A channel is a conversation many
 * people share, holding people and spores; a message reaches the spores it addresses — by their
 * role, or by replying to one's post — and a webhook cannot reply, so an answer opens with whom it
 * answers.
 */

import { readBot, routesOf, VERBS } from '@rhizogrip/spore/relay'
import { errorText, SporeError } from '@rhizogrip/spore'

import { header, isWorkingPost, plain } from './forward.js'

const FIELDS = ['token', 'channels', 'avatars', 'react']
const SNOWFLAKE = /^\d+$/
const HOOK_NAME = 'spore'
const NOBODY = { parse: [] }
const SHAPE = '{ "token": "${DISCORD_BOT_TOKEN}", "channels": { "<channel id>": { "spores": ["<spore>"], "people": ["<user id>", "role:<role id>"], "sporesTalk": false } } }' // eslint-disable-line no-template-curly-in-string

const invalid = (path, problem, detail = `a bot is ${SHAPE}`) => new SporeError(`${path} ${problem}`, { type: 'DISCORD_BOT_INVALID', detail })

/**
 * Each channel the bot serves, by id: its spores, the people who may address them (user ids,
 * `role:<id>`, `*`), whether a spore's post reaches the others (`sporesTalk`), and the relay's
 * `details`, `show` and `brief`. A channel absent from the file is not the bot's: Discord shows a bot every
 * channel it can see, and most are none of spore's business.
 */
const CONVERSATIONS = {
  channels: {
    noun: 'channel',
    id: SNOWFLAKE,
    says: 'which is not a channel id',
    fix: 'a channel id is the number Copy Channel ID gives, with Developer Mode on',
    fields: ['spores', 'people', 'sporesTalk', 'details', 'show', 'brief'],
    flags: ['sporesTalk'],
    people: { id: /^(role:)?\d+$/, says: 'user ids, role:<role id>', example: 'user id' }
  }
}

function check (raw, path) {
  if (raw.avatars !== undefined) {
    const avatars = typeof raw.avatars === 'object' && raw.avatars !== null && !Array.isArray(raw.avatars) ? Object.entries(raw.avatars) : null
    if (!avatars || !avatars.every(([, url]) => typeof url === 'string' && /^https:\/\/\S+$/.test(url))) {
      throw invalid(path, 'has avatars that are not { "<spore>": "https://…" }: Discord fetches each image from its address')
    }
  }
}

const HELP = 'Address a spore by its role — @triage — or by replying to its post. "@triage status" says what it is doing; "@triage stop" ends the turn it is running and sets aside what you sent that it had not read; "@triage wrap 10m" asks it to wrap up; "@triage flush" starts the conversation over, forgetting nothing'
const EXTEND = '"@triage extend wall 30m" gives it more, as far as its spore.cmk allows'

export const DISCORD = {
  kind: 'discord',
  label: 'Discord',
  noun: 'channel',
  fields: FIELDS,
  credentials: ['token'],
  stateFields: ['hooks', 'roles', 'guilds', 'unheard'],
  refusals: ['DISCORD_REFUSED'],
  example: SHAPE,
  conversations: CONVERSATIONS,
  check,
  usage: { help: `${HELP}; ${EXTEND}.`, briefHelp: `${HELP}.`, extend: '"@<spore> extend wall 30m", "@<spore> extend cost 1.50" or "@<spore> extend rounds 20"' },
  limits: { message: 1800, file: 20 * 1024 * 1024, fetch: 25 * 1024 * 1024, editEveryMs: 2500, typingEveryMs: 8000 },
  can: { upload: true, remove: true, react: true, typing: true, choose: false, fields: false },
  reactions: null,
  showShared: 'working',
  hint (err, { file }) {
    if (err.type === 'DISCORD_NO_BOT') return `mkdir -p ${file.slice(0, file.lastIndexOf('/'))} && echo '{"token": "$\{DISCORD_BOT_TOKEN}", "channels": {}}' > ${file}`
    if (err.type === 'DISCORD_FAILED') return `the token comes from the Discord Developer Portal, in the variable ${file} names`
    if (err.type === 'DISCORD_REFUSED') return 'Discord refused the bot: check its token, and that the Message Content intent is on in the Developer Portal'
    return null
  },
  refusal: () => null
}

const ADDRESSING = /^(\s*@[\w.-]+)+\s*/

/** `{ verb, args }` when what follows the mentions that address a spore is one of the relay's commands. */
function commandOf (rest) {
  const [verb] = rest.split(/\s+/)
  return VERBS.has(verb.toLowerCase()) ? { verb: verb.toLowerCase(), args: rest.slice(verb.length).trim() } : null
}

export function createAdapter ({ discord, me, botFile }) {
  const names = new Map()
  let kept = null
  let save = null

  const look = (as) => {
    if (as === null) return {}
    const avatars = readBot(DISCORD, botFile).avatars ?? {}
    return { username: as, ...(avatars[as] ? { avatar_url: avatars[as] } : {}) }
  }

  const hookOf = async (channel) => {
    if (!kept.hooks[channel]) {
      const own = (await discord.webhooks(channel)).find(hook => hook.user?.id === me.id && hook.token)
      const hook = own ?? await discord.createWebhook(channel, HOOK_NAME)
      kept.hooks[channel] = { id: hook.id, token: hook.token }
      save()
    }
    return kept.hooks[channel]
  }

  const rolesOf = async (guild, spores) => {
    const known = (kept.roles[guild] ??= {})
    const missing = spores.filter(spore => !known[spore])
    if (missing.length) {
      const roles = await discord.roles(guild)
      for (const spore of missing) known[spore] = (roles.find(role => role.name === spore) ?? await discord.createRole(guild, spore)).id
      save()
    }
    return known
  }

  const channelOf = async (channel) => {
    if (!names.has(channel) || !kept.guilds[channel]) {
      const found = await discord.channel(channel)
      kept.guilds[channel] = found.guild_id
      names.set(channel, found.name)
      save()
    }
  }

  /** Every message in a channel counts toward what each spore has not heard since it last spoke. */
  const heard = (channel, spores, speaker) => {
    const counts = (kept.unheard[channel] ??= {})
    for (const spore of spores) counts[spore] = spore === speaker ? 0 : (counts[spore] ?? 0) + 1
    save()
  }

  const opening = (answered) => answered.map(one => header(one.person, one.said)).join('\n')

  return {
    ...DISCORD,

    restore (state, persist) {
      kept = state
      save = persist
    },

    async prepare (table, log) {
      for (const [channel, { spores }] of table) {
        try {
          await channelOf(channel)
          await rolesOf(kept.guilds[channel], spores)
          await hookOf(channel)
        } catch (err) {
          log(`channel ${channel}: not ready — ${errorText(err)}`)
        }
      }
    },

    /**
     * The Gateway, a message at a time: one in a channel the bot file names, addressed to a spore
     * there, from a person or — where the channel lets spores talk — another spore's answer.
     */
    listen ({ onMessage, trace, signal, log, sleep }) {
      return discord.connect({
        onMessage: async (d) => {
          trace(`message ${d.id}`, d)
          if (d.author.id === me.id) return
          const entry = routesOf(DISCORD, botFile).get(d.channel_id)
          if (!entry) return
          await channelOf(d.channel_id)
          const roles = await rolesOf(d.guild_id, entry.spores)
          const hook = await hookOf(d.channel_id)
          const own = d.webhook_id === hook.id
          if (d.webhook_id && !own) return
          if (own && isWorkingPost(d.content)) return
          const speaker = own ? d.author.username : null
          heard(d.channel_id, entry.spores, speaker)
          if (own && !entry.sporesTalk) return

          const repliedTo = d.referenced_message?.webhook_id === hook.id ? d.referenced_message.author.username : null
          const addresses = entry.spores.filter(spore => spore !== speaker && (d.mention_roles.includes(roles[spore]) || spore === repliedTo))
          if (!addresses.length) return
          const content = plain(d.content, roles).trim()
          const rest = content.replace(ADDRESSING, '')
          await onMessage({
            id: d.id,
            conversation: d.channel_id,
            message: d.id,
            person: {
              id: d.author.id,
              name: own ? `${speaker} (spore)` : d.member?.nick ?? d.author.global_name ?? d.author.username,
              groups: d.member?.roles ?? []
            },
            spore: speaker,
            where: `the Discord channel "#${names.get(d.channel_id)}"`,
            shared: true,
            text: rest ? content : null,
            command: rest ? commandOf(rest) : null,
            addresses,
            files: d.attachments.map(file => ({ name: file.filename, mime: file.content_type ?? null, bytes: file.size ?? null, ref: file.url }))
          })
        },
        onReady: (ready) => log(`connected to Discord as ${ready.user.username}`),
        signal,
        log,
        sleep
      })
    },

    /** Where the conversation went since the spore last spoke, and how to read it. */
    aside: (message, spore) => {
      const before = kept.unheard[message.conversation][spore] - 1
      return `[Discord channel ${message.conversation}, message ${message.message}. ${before > 0 ? `${before} earlier message${before > 1 ? 's' : ''} here since you last spoke` : 'Nothing else said here since you last spoke'} — "$SPORE_DISCORD" history ${message.conversation} --before ${message.message} reads what was said before.]`
    },

    /** Under the spore's name, opened with whom it answers — pinged when it is the answer. */
    post: async (conversation, text, { answering = null, for: answered = [], as = null } = {}) => {
      const hook = await hookOf(conversation)
      const top = opening(answered)
      const pinged = answering === null ? [] : [...new Set(answered.map(one => one.person))]
      return (await discord.post(hook, { ...look(as), content: top ? `${top}\n${text}` : text, allowed_mentions: { parse: [], users: pinged } })).id
    },

    edit: async (conversation, note, text, { for: answered = [] } = {}) => {
      const top = opening(answered)
      await discord.revise(await hookOf(conversation), note, { content: top ? `${top}\n${text}` : text, allowed_mentions: NOBODY })
    },

    remove: async (conversation, note) => discord.remove(await hookOf(conversation), note),

    fetch: (ref, { most }) => discord.download(ref, { most }),

    upload: async (conversation, file, caption, { as = null } = {}) =>
      discord.upload(await hookOf(conversation), { ...look(as), content: caption, allowed_mentions: NOBODY }, [file]),

    /** The bot's reaction moved from `was` to `emoji`, either of them none. */
    react: async (conversation, message, emoji, was) => {
      if (was !== null && was !== emoji) await discord.unreact(conversation, message, was)
      if (emoji !== null) await discord.react(conversation, message, emoji)
    },

    typing: (conversation) => discord.typing(conversation)
  }
}
