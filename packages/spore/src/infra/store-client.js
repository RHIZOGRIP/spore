/**
 * The confined side of the store: vectors in, ids and distances out. Which collection, and the
 * credential that reaches it, stay with the runner.
 */

import { request } from './socket-request.js'

export function createStoreClient ({ socketPath, key, signal }) {
  const post = (path, body) => request(socketPath, { key, method: 'POST', path, body, what: 'store socket', signal })
  return {
    holds: (dimensions, ids) => post('/holds', { dimensions, ids }),
    index: (dimensions, unit, records) => post('/index', { dimensions, unit, records }),
    search: (dimensions, unit, vector, topK) => post('/search', { dimensions, unit, vector, topK })
  }
}
