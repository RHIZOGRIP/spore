/**
 * Discord's REST API and its Gateway, as the service uses them. Every REST failure is a
 * `DISCORD_FAILED`, `retryable` or not, with `context.status`, `context.code` (Discord's JSON
 * error code) and `context.retryAfter` (seconds, when Discord said how long to wait). A request
 * that never reached Discord is retryable.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename } from 'node:path'

import { errorText, SporeError } from '@rhizogrip/spore'
import { backoff, download, platformFailed } from '@rhizogrip/spore/relay'

const BASE = 'https://discord.com/api/v10'
export const USER_AGENT = `DiscordBot (https://github.com/RHIZOGRIP/spore, ${createRequire(import.meta.url)('../package.json').version})`

export const INTENTS = (1 << 0) | (1 << 9) | (1 << 15)

const RESUME = 6
const IDENTIFY = 2
const HEARTBEAT = 1
const DISPATCH = 0
const RECONNECT = 7
const INVALID_SESSION = 9
const HELLO = 10
const HEARTBEAT_ACK = 11
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014])

export function createDiscord (token, { fetchImpl = fetch, base = BASE, WebSocketImpl = globalThis.WebSocket, random = Math.random } = {}) {
  if (!token) {
    throw new SporeError('no bot token', {
      type: 'DISCORD_UNCONFIGURED',
      detail: 'a bot file names the variable holding its token from the Discord Developer Portal; it never reaches a spore'
    })
  }

  const call = async (method, path, { body, form, timeoutMs = 60_000, signal } = {}) => {
    const timeout = AbortSignal.timeout(timeoutMs)
    let response
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bot ${token}`,
          'user-agent': USER_AGENT,
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      })
    } catch (err) {
      if (signal?.aborted) throw err
      throw platformFailed('discord', `${method} ${path}`, { detail: err.message, retryable: true })
    }
    if (response.status === 204) return null
    const answer = await response.json().catch(() => null)
    if (!response.ok) {
      throw platformFailed('discord', `${method} ${path}`, {
        detail: answer?.message ? `${answer.message}${answer.code ? ` (${answer.code})` : ''}` : `HTTP ${response.status}`,
        retryable: response.status >= 500 || response.status === 429,
        status: response.status,
        code: answer?.code ?? null,
        retryAfter: answer?.retry_after ?? null
      })
    }
    return answer
  }

  const hookPath = (hook, rest = '') => `/webhooks/${hook.id}/${hook.token}${rest}`
  const withFiles = (payload, files) => {
    const form = new FormData()
    form.append('payload_json', JSON.stringify({ ...payload, attachments: files.map((file, id) => ({ id, filename: basename(file.path) })) }))
    files.forEach((file, id) => form.append(`files[${id}]`, new Blob([readFileSync(file.path)], { type: file.mime }), basename(file.path)))
    return form
  }

  /**
   * One Gateway connection after another until `signal` aborts, resuming the session where it
   * can and identifying anew where it cannot. Each message created is handed to `onMessage`,
   * one at a time, in the order Discord sent them. Fails on a close Discord says not to retry —
   * a refused token, a refused intent.
   */
  const connect = async ({ onMessage, onReady = () => {}, signal, log = () => {}, sleep }) => {
    let session = null
    const retry = backoff()
    while (!signal.aborted) {
      const url = session?.resumeUrl ?? (await call('GET', '/gateway/bot', { signal })).url
      const ended = await new Promise((resolve) => {
        const socket = new WebSocketImpl(`${url}/?v=10&encoding=json`)
        let beat = null
        let acked = true
        let handled = Promise.resolve()
        const send = (op, d) => socket.send(JSON.stringify({ op, d }))
        const heartbeat = () => {
          if (!acked) return socket.close(4900, 'no heartbeat ack')
          acked = false
          send(HEARTBEAT, session?.seq ?? null)
        }
        const stop = () => socket.close(1000, 'stopping')
        signal.addEventListener('abort', stop, { once: true })
        socket.addEventListener('message', (event) => {
          const { op, d, s, t } = JSON.parse(event.data)
          if (s !== null && s !== undefined && session) session.seq = s
          if (op === HELLO) {
            const first = setTimeout(() => {
              heartbeat()
              beat = setInterval(heartbeat, d.heartbeat_interval)
            }, d.heartbeat_interval * random())
            beat = first
            if (session?.id) send(RESUME, { token, session_id: session.id, seq: session.seq })
            else send(IDENTIFY, { token, intents: INTENTS, properties: { os: 'linux', browser: 'spore', device: 'spore' } })
          } else if (op === HEARTBEAT_ACK) {
            acked = true
          } else if (op === HEARTBEAT) {
            send(HEARTBEAT, session?.seq ?? null)
          } else if (op === RECONNECT) {
            socket.close(4900, 'asked to reconnect')
          } else if (op === INVALID_SESSION) {
            if (!d) session = null
            socket.close(4900, 'session invalid')
          } else if (op === DISPATCH) {
            if (t === 'READY') {
              session = { id: d.session_id, resumeUrl: d.resume_gateway_url, seq: s }
              retry.reset()
              onReady(d)
            }
            if (t === 'RESUMED') retry.reset()
            if (t === 'MESSAGE_CREATE') {
              handled = handled.then(() => onMessage(d)).catch(err => log(`message ${d.id}: ${errorText(err)}`))
            }
          }
        })
        socket.addEventListener('close', (event) => {
          clearTimeout(beat)
          clearInterval(beat)
          signal.removeEventListener('abort', stop)
          handled.then(() => resolve({ code: event.code, reason: event.reason }))
        })
      })
      if (signal.aborted) return
      if (FATAL_CLOSE.has(ended.code)) {
        throw new SporeError('Discord closed the Gateway and said not to come back', {
          type: 'DISCORD_REFUSED',
          detail: `${ended.code} ${ended.reason || ''}`.trim(),
          context: { code: ended.code }
        })
      }
      log(`gateway closed (${ended.code}${ended.reason ? ` ${ended.reason}` : ''}) — ${session ? 'resuming' : 'connecting again'}`)
      await sleep(retry.after())
    }
  }

  return {
    me: () => call('GET', '/users/@me'),
    channel: (channel) => call('GET', `/channels/${channel}`),
    roles: (guild) => call('GET', `/guilds/${guild}/roles`),
    createRole: (guild, name) => call('POST', `/guilds/${guild}/roles`, { body: { name, mentionable: true } }),
    webhooks: (channel) => call('GET', `/channels/${channel}/webhooks`),
    createWebhook: (channel, name) => call('POST', `/channels/${channel}/webhooks`, { body: { name } }),
    post: (hook, payload) => call('POST', hookPath(hook, '?wait=true'), { body: payload }),
    revise: (hook, message, payload) => call('PATCH', hookPath(hook, `/messages/${message}`), { body: payload }),
    remove: (hook, message) => call('DELETE', hookPath(hook, `/messages/${message}`)),
    upload: (hook, payload, files) => call('POST', hookPath(hook, '?wait=true'), { form: withFiles(payload, files), timeoutMs: 300_000 }),
    typing: (channel) => call('POST', `/channels/${channel}/typing`),
    react: (channel, message, emoji) => call('PUT', `/channels/${channel}/messages/${message}/reactions/${encodeURIComponent(emoji)}/@me`),
    unreact: (channel, message, emoji) => call('DELETE', `/channels/${channel}/messages/${message}/reactions/${encodeURIComponent(emoji)}/@me`),
    /** An attachment's bytes by its signed URL, which needs no token and expires, refused past `most`. */
    download: (url, { most }) => download(url, { most, fetchImpl }),
    connect
  }
}
