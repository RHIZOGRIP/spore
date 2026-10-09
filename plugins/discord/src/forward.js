/**
 * What a channel is told of a turn: the answer, and how the turn ended only when that makes the
 * answer partial. A spore posts under its own name through a webhook, which cannot reply, so an
 * answer opens with whom it answers and what they said.
 */

export const MAX_MESSAGE = 2000
const QUOTE = 60

const PLAIN_ENDINGS = new Set(['answer', 'question'])

const ending = (record) => [record.stopReason, record.error].filter(Boolean).join(' · ')

export function reply ({ record }) {
  const { output } = record
  if (output) return PLAIN_ENDINGS.has(record.stopReason) ? output : `${output}\n\n— ${ending(record)}`
  if (record.stopReason === 'quiet') return 'nothing to say'
  return `no answer · ${ending(record)}`
}

/** What a channel is told of a turn that answered `asked`, none of it said in a channel: who said it, then the answer. */
export function announce ({ record, asked }) {
  const named = (field) => [...new Set(asked.filter(entry => entry[field]).map(entry => `"${entry[field]}"`))]
  const origins = [
    named('schedule').length ? `schedule ${named('schedule').join(', ')}` : null,
    named('hook').length ? `webhook ${named('hook').join(', ')}` : null,
    named('job').length ? `job ${named('job').join(', ')}` : null
  ].filter(Boolean)
  return `${origins.length ? origins.join(' · ') : 'sent from elsewhere'}\n\n${reply({ record })}`
}

/** A turn ended without reading this message, and nothing is running to read it. */
export function waiting ({ record }) {
  return `no answer yet · ${ending(record)} — your message waits for the next turn`
}

const WORKING = /\n(working…|heard you — still working…)$/

/** What a spore posts while a turn works on `opening`'s message: the turn just started, or one already running heard it. */
export const workingPost = (opening, started) => `${opening}\n${started ? 'working…' : 'heard you — still working…'}`

/** True for a `working…` post: it is removed once the answer is posted, so it is not part of the conversation. */
export const isWorkingPost = (content) => WORKING.test(content)

/** `<@asker> ↪ "the first line of what they said…"`, which opens an answer to them. */
export function header (asker, said) {
  const line = String(said).split('\n')[0].replace(/\s+/g, ' ').trim()
  return `<@${asker}> ↪ "${line.length > QUOTE ? `${line.slice(0, QUOTE - 1)}…` : line}"`
}

export function pieces (text, limit = MAX_MESSAGE) {
  const out = []
  let rest = String(text)
  while (rest.length > limit) {
    const cut = rest.lastIndexOf('\n', limit)
    const at = cut > limit / 2 ? cut : limit
    out.push(rest.slice(0, at))
    rest = rest.slice(at).replace(/^\n/, '')
  }
  if (rest) out.push(rest)
  return out
}

/**
 * A message as a spore is told it: role mentions of spores read as `@<spore>`, and the rest as
 * Discord wrote it.
 */
export function plain (content, rolesBySpore) {
  const spores = new Map(Object.entries(rolesBySpore).map(([spore, role]) => [role, spore]))
  return String(content).replace(/<@&(\d+)>/g, (mention, role) => (spores.has(role) ? `@${spores.get(role)}` : mention))
}

const nameOf = (user) => user.global_name ?? user.username

/**
 * Channel history as an agent reads it, oldest first: each message's id, when, who — a post
 * through a webhook, as every spore's is, marked as one — and what it said, the people it
 * mentions by name and its files named. A role stays `<@&id>`: what a role is called is the
 * guild's, which history does not carry.
 */
export function historyLines (messages) {
  return [...messages].reverse().map((message) => {
    const who = message.webhook_id
      ? `${message.author.username} (webhook)`
      : `${nameOf(message.author)}${message.author.bot ? ' (bot)' : ''}`
    const people = new Map(message.mentions.map(user => [user.id, nameOf(user)]))
    const said = message.content.replace(/<@!?(\d+)>/g, (mention, id) => (people.has(id) ? `@${people.get(id)}` : mention))
    const files = message.attachments.map(file => ` [file ${file.filename}]`).join('')
    return `${message.id} ${message.timestamp} ${who}: ${said}${files}`
  })
}
