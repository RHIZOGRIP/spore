/**
 * The confined side of the source broker. It sends a name and gets back what the endpoint
 * said; the URL, the method and every credential stay with the runner. A cell sends its
 * view — the sources and scopes its precursor names — so it is shown and filled in within
 * that, and the root sends none.
 */

import { request } from './socket-request.js'

export function createSourceClient ({ socketPath, key, view, signal }) {
  const post = (path, body) => request(socketPath, { key, method: 'POST', path, body: { ...body, ...(view ? { view } : {}) }, what: 'source socket', signal })
  return {
    list: () => post('/list', {}),
    fetch: (source, params, { method, path, body } = {}) => post('/fetch', { source, params, method, path, body })
  }
}
