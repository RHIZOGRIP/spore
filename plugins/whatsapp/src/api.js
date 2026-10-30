/**
 * The WhatsApp Cloud API, as the service uses it: Meta's Graph API for one business phone number.
 * Every failure is a `WHATSAPP_FAILED`, `retryable` for what Meta asks a business to try again —
 * a throughput or rate limit, a service briefly unavailable, a request that never reached it — with
 * `context.status`, `context.code` (Meta's error code) and `context.retryAfter` in seconds; one
 * that says the token is no good is a `WHATSAPP_REFUSED`.
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { download, platformFailed, retryAfterOf } from '@rhizogrip/spore/relay'

const GRAPH = 'https://graph.facebook.com/v26.0'
const RETRYABLE = new Set([2, 4, 80007, 130429, 131000, 131016, 131056])
const REFUSED = new Set([10, 190])
const PAIR_RATE = 131056
const PAIR_WAIT = 6

export function createGraph ({ token, number }) {
  const call = async (method, path, body) => {
    let response
    try {
      response = await fetch(`${GRAPH}/${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined || body instanceof FormData ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined || body instanceof FormData ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000)
      })
    } catch (err) {
      throw platformFailed('whatsapp', method, { detail: err.message, retryable: true })
    }
    const answer = await response.json().catch(() => null)
    if (!response.ok) {
      const code = answer?.error?.code ?? null
      throw platformFailed('whatsapp', method, {
        detail: answer?.error?.error_data?.details ?? answer?.error?.message ?? `HTTP ${response.status}`,
        retryable: RETRYABLE.has(code) || response.status >= 500,
        status: response.status,
        code,
        retryAfter: code === PAIR_RATE ? PAIR_WAIT : retryAfterOf(response),
        ...(REFUSED.has(code) ? { type: 'WHATSAPP_REFUSED' } : {})
      })
    }
    return answer
  }

  const message = async (body) => (await call('POST', `${number}/messages`, { messaging_product: 'whatsapp', ...body })).messages[0].id

  return {
    /** The number as Meta names it: `{ verified_name, display_phone_number }`. */
    me: () => call('GET', `${number}?fields=verified_name,display_phone_number`),

    /** A message to a person by their business-scoped user id, quoting `answering` when it is not null; answers its id. */
    send: (person, content, answering = null) => message({ recipient_type: 'individual', recipient: person, ...content, ...(answering === null ? {} : { context: { message_id: answering } }) }),

    /** The bot's reaction on a person's message; an empty `emoji` takes it off. */
    react: (person, id, emoji) => message({ recipient_type: 'individual', recipient: person, type: 'reaction', reaction: { message_id: id, emoji } }),

    /** A person's message marked read, with the typing indicator shown until the bot answers or 25 s pass. */
    typing: (id) => call('POST', `${number}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: id, typing_indicator: { type: 'text' } }),

    /** A file put on Meta's servers for this number, sent as a document under its own name; answers the message's id. */
    document: async (person, { path, mime }, caption) => {
      const form = new FormData()
      form.set('messaging_product', 'whatsapp')
      form.set('type', mime)
      form.set('file', new Blob([await readFile(path)], { type: mime }), basename(path))
      const { id } = await call('POST', `${number}/media`, form)
      return message({ recipient_type: 'individual', recipient: person, type: 'document', document: { id, filename: basename(path), caption } })
    },

    /** A file a person sent, by its media id, refused past `most`: its URL lasts five minutes and is fetched with the token. */
    download: async (media, { most }) => {
      const { url } = await call('GET', `${encodeURIComponent(media)}?phone_number_id=${number}`)
      return download(url, { most, headers: { authorization: `Bearer ${token}` } })
    }
  }
}
