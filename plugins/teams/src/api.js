/**
 * The Bot Connector's REST API, as the service uses it. Every failure is a `TEAMS_FAILED`,
 * `retryable` for what Microsoft asks a bot to try again — 412, 429, 502, 503, 504, and a request
 * that never reached it — with `context.status`, `context.code` and `context.retryAfter` (seconds,
 * when Microsoft said how long to wait).
 */

import { SporeError } from '@rhizogrip/spore'

const RETRYABLE = new Set([412, 429, 502, 503, 504])

const base = (serviceUrl) => serviceUrl.endsWith('/') ? serviceUrl : `${serviceUrl}/`

export function createConnector ({ token, fetchImpl = fetch }) {
  const call = async (method, url, body) => {
    const bearer = await token()
    let response
    try {
      response = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000)
      })
    } catch (err) {
      throw new SporeError(`teams ${method} failed`, { type: 'TEAMS_FAILED', detail: err.message, retryable: true, context: { status: null, code: null, retryAfter: null } })
    }
    const answer = await response.json().catch(() => null)
    if (!response.ok) {
      const after = Number(response.headers.get('retry-after'))
      throw new SporeError(`teams ${method} failed`, {
        type: 'TEAMS_FAILED',
        detail: answer?.error?.message ?? answer?.message ?? `HTTP ${response.status}`,
        retryable: RETRYABLE.has(response.status),
        context: { status: response.status, code: answer?.error?.code ?? null, retryAfter: Number.isFinite(after) && after > 0 ? after : null }
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
    create: (serviceUrl, body) => call('POST', `${base(serviceUrl)}v3/conversations`, body)
  }
}
