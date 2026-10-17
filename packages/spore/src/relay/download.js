import { SporeError } from '../index.js'

/**
 * A file a person sent, fetched for the relay: the whole of it, or `FILE_TOO_LARGE` the moment it
 * passes `most` bytes — as the platform declares it or as it arrives, reading no further.
 * `FILE_FETCH_FAILED` otherwise, `retryable` for a 5xx, a 429 or no answer. No error names the
 * URL, which on some platforms carries the bot's token.
 */
export async function download (url, { most, headers = {}, fetchImpl = fetch, timeoutMs = 120_000 }) {
  const failed = (detail, retryable) => new SporeError('the file could not be fetched', { type: 'FILE_FETCH_FAILED', detail, retryable })
  const tooLarge = (bytes) => new SporeError('the file is larger than this bot takes', { type: 'FILE_TOO_LARGE', detail: `more than ${most} bytes`, context: { bytes } })
  let response
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    throw failed(err.message, true)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw failed(`HTTP ${response.status}`, response.status >= 500 || response.status === 429)
  }
  const declared = Number(response.headers.get('content-length'))
  if (declared > most) {
    await response.body?.cancel()
    throw tooLarge(declared)
  }
  const chunks = []
  let bytes = 0
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length
      if (bytes > most) throw tooLarge(null)
      chunks.push(chunk)
    }
  } catch (err) {
    if (err.type === 'FILE_TOO_LARGE') throw err
    throw failed(err.message, true)
  }
  return Buffer.concat(chunks)
}
