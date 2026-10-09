/**
 * Every failure is a `TELEGRAM_FAILED`, `retryable` or not, with `context.status` and
 * `context.retryAfter` (seconds, when Telegram said how long to wait). A request that never
 * reached Telegram is retryable.
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

import { SporeError } from '@rhizogrip/spore'

const BASE = 'https://api.telegram.org'

export function createTelegram (token, { fetchImpl = fetch, base = BASE } = {}) {
  if (!token) {
    throw new SporeError('no bot token', {
      type: 'TELEGRAM_UNCONFIGURED',
      detail: 'a bot file names the variable holding its token from @BotFather; it never reaches a spore'
    })
  }

  const call = async (method, body, { timeoutMs = 60_000, signal } = {}) => {
    const timeout = AbortSignal.timeout(timeoutMs)
    const form = body instanceof FormData
    let response
    try {
      response = await fetchImpl(`${base}/bot${token}/${method}`, {
        method: 'POST',
        ...(form ? {} : { headers: { 'content-type': 'application/json' } }),
        body: form ? body : JSON.stringify(body ?? {}),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      })
    } catch (err) {
      if (signal?.aborted) throw err
      throw new SporeError(`telegram ${method} failed`, { type: 'TELEGRAM_FAILED', detail: err.message, retryable: true, context: { status: null, retryAfter: null } })
    }
    const answer = await response.json().catch(() => null)
    if (!answer?.ok) {
      throw new SporeError(`telegram ${method} failed`, {
        type: 'TELEGRAM_FAILED',
        detail: answer?.description || `HTTP ${response.status}`,
        retryable: response.status >= 500 || response.status === 429,
        context: { status: response.status, retryAfter: answer?.parameters?.retry_after ?? null }
      })
    }
    return answer.result
  }

  return {
    /** `offset` confirms every update before it to Telegram. */
    updates: (offset, { seconds = 30, signal } = {}) =>
      call('getUpdates', { offset, timeout: seconds, allowed_updates: ['message'] }, { timeoutMs: (seconds + 15) * 1000, signal }),

    say: (chat, text) => call('sendMessage', { chat_id: chat, text, link_preview_options: { is_disabled: true } }),

    revise: (chat, message, text) =>
      call('editMessageText', { chat_id: chat, message_id: message, text, link_preview_options: { is_disabled: true } }),

    document: (chat, { path, mime }, caption) => {
      const form = new FormData()
      form.append('chat_id', String(chat))
      form.append('caption', caption)
      form.append('document', new Blob([readFileSync(path)], { type: mime }), basename(path))
      return call('sendDocument', form, { timeoutMs: 300_000 })
    },

    me: () => call('getMe')
  }
}
