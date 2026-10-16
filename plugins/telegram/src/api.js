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
      call('getUpdates', { offset, timeout: seconds, allowed_updates: ['message', 'callback_query'] }, { timeoutMs: (seconds + 15) * 1000, signal }),

    say: (chat, text, { answering = null, html = false } = {}) => call('sendMessage', {
      chat_id: chat,
      text,
      link_preview_options: { is_disabled: true },
      ...(html ? { parse_mode: 'HTML' } : {}),
      ...(answering === null ? {} : { reply_parameters: { message_id: answering, allow_sending_without_reply: true } })
    }),

    revise: (chat, message, text) =>
      call('editMessageText', { chat_id: chat, message_id: message, text, link_preview_options: { is_disabled: true } }),

    /** A question in Telegram's HTML with `keyboard`, rows of inline buttons, under it. */
    ask: (chat, html, keyboard) => call('sendMessage', {
      chat_id: chat,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: keyboard }
    }),

    /** A question's text replaced, and its buttons gone. */
    close: (chat, message, html) => call('editMessageText', {
      chat_id: chat,
      message_id: message,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [] }
    }),

    /** A press answered, with `text` as the short notice Telegram shows, or none. */
    answer: (query, text) => call('answerCallbackQuery', { callback_query_id: query, ...(text ? { text } : {}) }),

    remove: (chat, message) => call('deleteMessage', { chat_id: chat, message_id: message }),

    /** `emoji` on the message as the bot's one reaction, or none when it is null. */
    react: (chat, message, emoji) =>
      call('setMessageReaction', { chat_id: chat, message_id: message, reaction: emoji === null ? [] : [{ type: 'emoji', emoji }] }),

    typing: (chat) => call('sendChatAction', { chat_id: chat, action: 'typing' }),

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
