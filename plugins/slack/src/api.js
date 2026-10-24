/**
 * Slack's Web API, as the service uses it, form-encoded under the bot's token — the app-level
 * token for `apps.connections.open` alone. Every failure is a `SLACK_FAILED`, `retryable` for a
 * rate limit, a Slack-side error and a request that never reached Slack, with `context.status`,
 * `context.code` (Slack's `error`) and `context.retryAfter` (seconds, when Slack said how long to
 * wait); a token Slack will not have at all is a `SLACK_REFUSED`.
 */

import { download, platformFailed, retryAfterOf } from '@rhizogrip/spore/relay'

const BASE = 'https://slack.com/api/'
const RETRYABLE = new Set(['ratelimited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout'])
const REFUSED = new Set(['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'not_allowed_token_type'])
const HINTS = {
  not_in_channel: 'invite the bot to the channel with /invite @<the bot>',
  channel_not_found: 'the channel is gone, or private and without the bot in it',
  is_archived: 'the channel is archived',
  missing_scope: 'add it to the app\'s bot token scopes at api.slack.com/apps, then reinstall the app — the manifest in the plugin\'s README lists every scope'
}

const failed = (method, { detail, code = null, ...rest }) => platformFailed('slack', method, {
  ...rest,
  code,
  detail: HINTS[code] ? `${detail} — ${HINTS[code]}` : detail,
  ...(REFUSED.has(code) ? { type: 'SLACK_REFUSED' } : {})
})

export function createSlack ({ token, app, fetchImpl = fetch, base = BASE }) {
  const call = async (method, args = {}, bearer = token) => {
    const form = new URLSearchParams()
    for (const [name, value] of Object.entries(args)) {
      if (value !== undefined) form.set(name, typeof value === 'string' ? value : JSON.stringify(value))
    }
    let response
    try {
      response = await fetchImpl(`${base}${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(60_000)
      })
    } catch (err) {
      throw failed(method, { detail: err.message, retryable: true })
    }
    if (response.status === 429) {
      await response.body?.cancel()
      throw failed(method, { detail: 'ratelimited', retryable: true, status: 429, code: 'ratelimited', retryAfter: retryAfterOf(response) })
    }
    const answer = await response.json().catch(() => null)
    if (!response.ok || answer === null) throw failed(method, { detail: `HTTP ${response.status}`, retryable: response.status >= 500, status: response.status })
    if (!answer.ok) throw failed(method, { detail: answer.needed ? `${answer.error} ${answer.needed}` : answer.error, retryable: RETRYABLE.has(answer.error), status: response.status, code: answer.error })
    return answer
  }

  return {
    /** Who the bot token is: `{ user_id, user, team_id, team, bot_id }`. */
    whoami: () => call('auth.test'),

    /** A Socket Mode URL, asked under the app-level token. */
    connection: async () => (await call('apps.connections.open', {}, app)).url,

    /** A message posted; answers its `ts`. */
    post: async (args) => (await call('chat.postMessage', args)).ts,

    update: (args) => call('chat.update', args),

    remove: (args) => call('chat.delete', args),

    ephemeral: (args) => call('chat.postEphemeral', args),

    /** The direct message between the bot and a person, opened when there is none yet: its channel id. */
    im: async (user) => (await call('conversations.open', { users: user })).channel.id,

    user: async (id) => (await call('users.info', { user: id })).user,

    channel: async (id) => (await call('conversations.info', { channel: id })).channel,

    file: async (id) => (await call('files.info', { file: id })).file,

    /** A file a person sent, by its private URL, which Slack serves under the bot's token; refused past `most`. */
    download: (url, { most }) => download(url, { most, fetchImpl, headers: { authorization: `Bearer ${token}` } })
  }
}
