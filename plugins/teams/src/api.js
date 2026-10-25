/**
 * The Bot Connector's REST API, as the service uses it. Every failure is a `TEAMS_FAILED`,
 * `retryable` for what Microsoft asks a bot to try again — 412, 429, 502, 503, 504, and a request
 * that never reached it — with `context.status`, `context.code` and `context.retryAfter` (seconds,
 * when Microsoft said how long to wait).
 */

import { download, platformFailed, retryAfterOf } from '@rhizogrip/spore/relay'

const RETRYABLE = new Set([412, 429, 502, 503, 504])

const base = (serviceUrl) => serviceUrl.endsWith('/') ? serviceUrl : `${serviceUrl}/`

export function createConnector ({ token }) {
  const call = async (method, url, body) => {
    const bearer = await token()
    let response
    try {
      response = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000)
      })
    } catch (err) {
      throw platformFailed('teams', method, { detail: err.message, retryable: true })
    }
    const answer = await response.json().catch(() => null)
    if (!response.ok) {
      throw platformFailed('teams', method, {
        detail: answer?.error?.message ?? answer?.message ?? `HTTP ${response.status}`,
        retryable: RETRYABLE.has(response.status),
        status: response.status,
        code: answer?.error?.code ?? null,
        retryAfter: retryAfterOf(response)
      })
    }
    return answer
  }

  const activities = (serviceUrl, conversation) => `${base(serviceUrl)}v3/conversations/${encodeURIComponent(conversation)}/activities`

  return {
    /** An activity into a conversation; answers its id. */
    send: async (serviceUrl, conversation, activity) => (await call('POST', activities(serviceUrl, conversation), activity)).id,

    update: (serviceUrl, conversation, id, activity) => call('PUT', `${activities(serviceUrl, conversation)}/${encodeURIComponent(id)}`, activity),

    remove: (serviceUrl, conversation, id) => call('DELETE', `${activities(serviceUrl, conversation)}/${encodeURIComponent(id)}`),

    /** A conversation made — a person's chat with the bot, or a new post in a channel: `{ id, activityId }`. */
    create: (serviceUrl, body) => call('POST', `${base(serviceUrl)}v3/conversations`, body),

    /** A file a person sent, refused past `most` — `withToken` where Teams serves it only to the bot. */
    download: async (url, { most, withToken = false }) =>
      download(url, { most, headers: withToken ? { authorization: `Bearer ${await token()}` } : {} })
  }
}
