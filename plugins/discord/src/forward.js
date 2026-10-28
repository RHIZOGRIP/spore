/**
 * What Discord's text is, and what it becomes: a spore posts under its own name through a webhook,
 * which cannot reply, so an answer opens with whom it answers and what they said; role mentions of
 * spores read as their names; and channel history as an agent reads it.
 */

const QUOTE = 60

const WORKING = /(^|\n)(working…|heard you — still working…)$/

/** True for a `working…` post: it is removed once the answer is posted, so it is not part of the conversation. */
export const isWorkingPost = (content) => WORKING.test(content)

/** `<@asker> ↪ "the first line of what they said…"`, which opens an answer to them. */
export function header (asker, said) {
  const line = String(said).split('\n')[0].replace(/\s+/g, ' ').trim()
  return `<@${asker}> ↪ "${line.length > QUOTE ? `${line.slice(0, QUOTE - 1)}…` : line}"`
}

/**
 * A message as a spore is told it: mentions of spores — of their roles, and of the users
 * `usersBySpore` gives one — read as `@<spore>`, and the rest as Discord wrote it.
 */
export function plain (content, rolesBySpore, usersBySpore) {
  const byRole = new Map(Object.entries(rolesBySpore).map(([spore, role]) => [role, spore]))
  const byUser = new Map(Object.entries(usersBySpore).map(([spore, user]) => [user, spore]))
  return String(content)
    .replace(/<@&(\d+)>/g, (mention, role) => (byRole.has(role) ? `@${byRole.get(role)}` : mention))
    .replace(/<@!?(\d+)>/g, (mention, user) => (byUser.has(user) ? `@${byUser.get(user)}` : mention))
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
