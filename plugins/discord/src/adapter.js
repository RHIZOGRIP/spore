/**
 * Discord for the relay (`@rhizogrip/spore/relay`): the bot file, the Gateway that hears channels,
 * and the webhook each spore speaks through under its own name. A channel is a conversation many
 * people share, holding people and spores; a message reaches the spores it addresses — by their
 * role, by replying to one's post, or by mentioning the bot where a channel has one spore — and a
 * webhook cannot reply, so an answer opens with whom it answers.
 */

import { APPROVAL_LIMITS, readBot, routesOf, VERBS } from '@rhizogrip/spore/relay'
import { errorText, SporeError } from '@rhizogrip/spore'

import { header, isWorkingPost, plain } from './forward.js'

const FIELDS = ['token', 'channels', 'avatars', 'react']
const SNOWFLAKE = /^\d+$/
const HOOK_NAME = 'spore'
const NOBODY = { parse: [] }
const SHAPE = '{ "token": "${DISCORD_BOT_TOKEN}", "channels": { "<channel id>": { "spores": ["<spore>"], "people": ["<user id>", "role:<role id>"], "sporesTalk": false } } }' // eslint-disable-line no-template-curly-in-string

const BODY = 'Discord takes no approval body of its own yet — give the approval a default { "text", "facts" }'
const BUTTON_STYLES = { positive: 3, destructive: 4 }
const SECONDARY = 2
const PER_ROW = 5
const COMPONENT = 3
const MODAL_SUBMIT = 5
const ANSWER = 4
const MODAL = 9
const ACKNOWLEDGED = 6
const EPHEMERAL = 1 << 6
const LABEL = 18
const TEXT_INPUT = 4
const SHORT = 1
const PARAGRAPH = 2
const STRING_SELECT = 3
const RADIO_GROUP = 21
const CHECKBOX_GROUP = 22

const invalid = (path, problem, detail = `a bot is ${SHAPE}`) => new SporeError(`${path} ${problem}`, { type: 'DISCORD_BOT_INVALID', detail })

/**
 * Each channel the bot serves, by id: its spores, the people who may address them (user ids,
 * `role:<id>`, `*`), whether a spore's post reaches the others (`sporesTalk`), whether only a role
 * addresses a spore there and never a mention of the bot (`rolesOnly`), and the relay's
 * `details`, `show` and `brief`. A channel absent from the file is not the bot's: Discord shows a bot every
 * channel it can see, and most are none of spore's business.
 */
const CONVERSATIONS = {
  channels: {
    noun: 'channel',
    id: SNOWFLAKE,
    says: 'which is not a channel id',
    fix: 'a channel id is the number Copy Channel ID gives, with Developer Mode on',
    fields: ['spores', 'people', 'sporesTalk', 'rolesOnly', 'details', 'show', 'brief'],
    flags: ['sporesTalk', 'rolesOnly'],
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

const HELP = 'Address a spore by its role — @triage — or by replying to its post; where a channel has one spore, mentioning the bot addresses it too. "@triage status" says what it is doing; "@triage stop" ends the turn it is running and sets aside what you sent that it had not read; "@triage wrap 10m" asks it to wrap up; "@triage flush" starts the conversation over, forgetting nothing'
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
  can: { upload: true, edit: true, remove: true, react: true, typing: true, choose: true, fields: { text: true, choice: { several: true, list: 10, menu: 25 } } },
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

/** An approval's default body as Discord shows it: its text, which Discord's Markdown reads as is, then each fact on a line. */
const bodyOf = (fallback) => [
  fallback.text ?? null,
  fallback.facts?.length ? fallback.facts.map(([label, value]) => `**${label}**: ${value}`).join('\n') : null
].filter(Boolean).join('\n\n')

const rowsOf = (buttons) => Array.from({ length: Math.ceil(buttons.length / PER_ROW) }, (_, i) => ({ type: 1, components: buttons.slice(i * PER_ROW, (i + 1) * PER_ROW) }))

const optionsOf = (field) => field.choices.map(choice => ({ value: choice.id, label: choice.label, ...(field.value.includes(choice.id) ? { default: true } : {}) }))

/**
 * A field as Discord draws it in a modal, inside its label: a text short or long; a choice as a
 * menu, a radio group where one of several is picked from a list, or a checkbox group.
 */
function inputOf (field) {
  if (field.kind !== 'choice') {
    return { type: TEXT_INPUT, custom_id: field.id, style: field.lines > 1 ? PARAGRAPH : SHORT, required: field.required === true, max_length: APPROVAL_LIMITS.input, ...(field.value ? { value: field.value } : {}) }
  }
  const { least, most } = field
  const options = optionsOf(field)
  if (field.look === 'menu') return { type: STRING_SELECT, custom_id: field.id, options, min_values: least, max_values: most, required: least > 0 }
  if (most === 1 && options.length > 1) return { type: RADIO_GROUP, custom_id: field.id, options, required: least > 0 }
  return { type: CHECKBOX_GROUP, custom_id: field.id, options, min_values: least, max_values: most, required: least > 0 }
}

/** What a modal's submit filled in, by field id: a text's words, a choice's ids picked. */
function inputsOf (components) {
  return Object.fromEntries(components.map(({ component }) => {
    if (component.type === TEXT_INPUT) return [component.custom_id, component.value]
    if (component.type === RADIO_GROUP) return [component.custom_id, component.value === null ? [] : [component.value]]
    return [component.custom_id, component.values]
  }))
}

const personOf = (interaction) => {
  const user = interaction.member?.user ?? interaction.user
  return { id: user.id, name: interaction.member?.nick ?? user.global_name ?? user.username }
}

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
      for (const spore of missing) known[spore] = (roles.find(role => role.name === spore && !role.managed) ?? await discord.createRole(guild, spore)).id
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
    listen ({ onMessage, onChoice, formOf, trace, signal, log, sleep }) {
      const acknowledging = (interaction) => (text) => discord.respond(interaction, text === null
        ? { type: ACKNOWLEDGED }
        : { type: ANSWER, data: { content: text, flags: EPHEMERAL, allowed_mentions: NOBODY } })

      /**
       * A press on one of the relay's buttons: answered with a modal of the approval's fields,
       * whose submit is the press, where it has some to fill in and may go on; else the press
       * itself, taken or refused at once.
       */
      const pressed = async (interaction) => {
        const press = { conversation: interaction.channel_id, data: interaction.data.custom_id, person: personOf(interaction) }
        if (interaction.type === MODAL_SUBMIT) {
          return onChoice({ ...press, inputs: inputsOf(interaction.data.components), acknowledge: acknowledging(interaction) })
        }
        const form = formOf(press)
        if (!form?.fields.length) return onChoice({ ...press, inputs: null, acknowledge: acknowledging(interaction) })
        await discord.respond(interaction, {
          type: MODAL,
          data: { custom_id: press.data, title: form.option.label, components: form.fields.map(field => ({ type: LABEL, label: field.label, component: inputOf(field) })) }
        })
      }

      return discord.connect({
        onInteraction: async (d) => {
          trace(`interaction ${d.id}`, d)
          if (d.type === COMPONENT || d.type === MODAL_SUBMIT) await pressed(d)
        },
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
          const toBot = d.mentions.some(user => user.id === me.id)
          const byBot = toBot && !entry.rolesOnly && entry.spores.length === 1
          const addresses = entry.spores.filter(spore => spore !== speaker && (byBot || d.mention_roles.includes(roles[spore]) || spore === repliedTo))
          if (!addresses.length) {
            if (toBot && !own) log(`message ${d.id} mentions the bot, which reaches no spore in channel ${d.channel_id}: ${entry.rolesOnly ? 'it says rolesOnly' : `it routes ${entry.spores.length} spores`} — mention a spore's role instead, ${entry.spores.map(spore => `@${spore}`).join(', ')}`)
            return
          }
          const content = plain(d.content, roles, byBot ? { [entry.spores[0]]: me.id } : {}).trim()
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

    typing: (conversation) => discord.typing(conversation),

    checkBody: () => BODY,

    /** The question under the spore's name, a button per choice, five to a row, coloured where it has a style. */
    ask: async (conversation, { fallback }, choices, { as }) => {
      const buttons = choices.map(choice => ({ type: 2, style: BUTTON_STYLES[choice.style] ?? SECONDARY, label: choice.label, custom_id: choice.data }))
      const payload = { ...look(as), content: bodyOf(fallback), components: rowsOf(buttons), allowed_mentions: NOBODY }
      return { note: (await discord.ask(await hookOf(conversation), payload)).id, shown: payload }
    },

    /** The question closed, its buttons gone: replaced by the hook's default body, or kept with how it ended below. */
    settle: async (conversation, note, replacement) => {
      if (replacement.native) throw new SporeError('Discord cannot show this replacement', { type: 'DISCORD_ASK_REFUSED', detail: BODY, retryable: false })
      const content = replacement.shown ? `${replacement.shown.content}\n-# ${replacement.outcome}` : bodyOf(replacement.fallback)
      const payload = { content, components: [], allowed_mentions: NOBODY }
      await discord.close(await hookOf(conversation), note, payload)
      return payload
    }
  }
}
