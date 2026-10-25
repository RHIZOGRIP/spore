/**
 * One JSON request to a socket the runner serves — model, store or source — presenting the
 * tree's key. A refusal comes back as mohdel's typed error and is thrown as a SporeError.
 */

import http from 'node:http'

import { SporeError } from '../observability/errors.js'

export const KEY_HEADER = 'x-spore-key'
// On the model socket: the root agent's calls, which the runner counts as the turn's own,
// and the call's id, by which it can abort one past its ceiling.
export const CALLER_HEADER = 'x-spore-caller'
export const ROOT_CALLER = 'root'
export const PRECURSOR_CALLER = 'precursor:'
export const MODEL_CALL_HEADER = 'x-spore-model-call'

export const typedError = (error) => new SporeError(error?.message || 'broker call failed', {
  type: error?.type || 'BROKER_FAILED',
  detail: error?.detail,
  retryable: Boolean(error?.retryable),
  retryAfterMs: error?.retryAfterMs
})

export function request (socketPath, { key, method, path, body, what, signal }) {
  return new Promise((resolve, reject) => {
    const cancelled = () => new SporeError('operation cancelled', { type: 'OPERATION_CANCELLED', detail: `${what} ${path} was aborted`, severity: 'info' })
    if (signal?.aborted) return reject(cancelled())
    const headers = { [KEY_HEADER]: key, ...(body ? { 'content-type': 'application/json' } : {}) }
    const req = http.request({ socketPath, path, method, headers }, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          reject(new SporeError(`${what} answered ${path} with what is not JSON`, { type: 'BROKER_FAILED', detail: text.slice(0, 200) }))
          return
        }
        if (res.statusCode !== 200) reject(typedError(parsed))
        else resolve(parsed)
      })
    })
    const abort = () => {
      req.destroy()
      reject(cancelled())
    }
    signal?.addEventListener('abort', abort, { once: true })
    req.on('close', () => signal?.removeEventListener('abort', abort))
    req.on('error', (e) => reject(new SporeError(`${what} unreachable`, {
      type: 'BROKER_UNREACHABLE',
      detail: `${socketPath}: ${e.code || e.message}`
    })))
    req.end(body ? JSON.stringify(body) : undefined)
  })
}
