/**
 * A bot's identity with Microsoft, both ways: the token it sends the Bot Connector, from its
 * tenant's authority, and the check of the token the Bot Connector sends with each activity. A
 * failure to reach Microsoft is a `TEAMS_FAILED`, retryable; Microsoft refusing the bot's app id or
 * secret is a `TEAMS_REFUSED`, which a service cannot get past by waiting.
 */

import { createPublicKey, verify } from 'node:crypto'

import { SporeError } from '@rhizogrip/spore'

const AUTHORITY = 'https://login.microsoftonline.com'
const OPENID = 'https://login.botframework.com/v1/.well-known/openidconfiguration'
const ISSUER = 'https://api.botframework.com'
const SCOPE = 'https://api.botframework.com/.default'
const SKEW_S = 300
const KEYS_EVERY_MS = 24 * 60 * 60 * 1000
const UNKNOWN_KEY_EVERY_MS = 60 * 1000

const unreachable = (what, err) => new SporeError(`${what} failed`, { type: 'TEAMS_FAILED', detail: err.message, retryable: true, context: { status: null, retryAfter: null } })

/** The bot's bearer token for the Bot Connector, asked of its tenant and kept until shortly before it expires. */
export function createToken ({ app, tenant, secret, fetchImpl = fetch, now = Date.now, authority = AUTHORITY }) {
  let held = null
  return async () => {
    if (held && held.until > now()) return held.token
    let response
    try {
      response = await fetchImpl(`${authority}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: app, client_secret: secret, scope: SCOPE }),
        signal: AbortSignal.timeout(30_000)
      })
    } catch (err) {
      throw unreachable('asking Microsoft for a token', err)
    }
    const answer = await response.json().catch(() => null)
    if (!response.ok || typeof answer?.access_token !== 'string') {
      throw new SporeError('Microsoft gave the bot no token', {
        type: response.status >= 500 ? 'TEAMS_FAILED' : 'TEAMS_REFUSED',
        detail: answer?.error_description?.split('\r\n')[0] ?? `HTTP ${response.status}`,
        retryable: response.status >= 500,
        context: { status: response.status, retryAfter: null }
      })
    }
    held = { token: answer.access_token, until: now() + (answer.expires_in - SKEW_S) * 1000 }
    return held.token
  }
}

const decoded = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

const sameService = (one, other) => typeof one === 'string' && typeof other === 'string' &&
  one.toLowerCase().replace(/\/+$/, '') === other.toLowerCase().replace(/\/+$/, '')

/**
 * The check of an activity's `Authorization`: a JWT Microsoft signed with RS256, by a key it
 * publishes and endorses for the activity's channel, issued by the Bot Connector for this app id,
 * in its time, for the `serviceUrl` the activity names. Answers null when it holds, else why not.
 * The keys are read from Microsoft's OpenID metadata, again each day and when a token names one
 * they do not hold.
 */
export function createVerifier ({ app, fetchImpl = fetch, now = Date.now, openid = OPENID }) {
  let keys = null
  const load = async () => {
    try {
      const config = await (await fetchImpl(openid, { signal: AbortSignal.timeout(30_000) })).json()
      const set = await (await fetchImpl(config.jwks_uri, { signal: AbortSignal.timeout(30_000) })).json()
      keys = { at: now(), byKid: new Map(set.keys.map(key => [key.kid, key])) }
    } catch (err) {
      throw unreachable('reading the keys Microsoft signs activities with', err)
    }
  }
  const keyOf = async (kid) => {
    if (!keys || now() - keys.at > KEYS_EVERY_MS) await load()
    if (!keys.byKid.has(kid) && now() - keys.at > UNKNOWN_KEY_EVERY_MS) await load()
    return keys.byKid.get(kid) ?? null
  }

  return async (authorization, activity) => {
    const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1]
    if (!token) return 'it carries no bearer token'
    const parts = token.split('.')
    let header, claims
    try {
      if (parts.length !== 3) throw new Error('three parts')
      header = decoded(parts[0])
      claims = decoded(parts[1])
    } catch {
      return 'its token is not a JWT'
    }
    if (header.alg !== 'RS256') return `its token is signed with ${header.alg}, not RS256`
    const jwk = await keyOf(header.kid)
    if (!jwk) return `its token names key ${header.kid}, which Microsoft does not publish`
    if (!(jwk.endorsements ?? []).includes(activity.channelId)) return `key ${header.kid} is not endorsed for ${activity.channelId}`
    const key = createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' })
    if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) return 'its token\'s signature does not hold'
    if (claims.iss !== ISSUER) return `its token was issued by ${claims.iss}`
    if (claims.aud !== app) return `its token is for ${claims.aud}, not this bot`
    const at = now() / 1000
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < at) return 'its token has expired'
    if (typeof claims.nbf === 'number' && claims.nbf - SKEW_S > at) return 'its token is not valid yet'
    if (!sameService(claims.serviceurl, activity.serviceUrl)) return 'its token is for another serviceUrl than the activity names'
    return null
  }
}
