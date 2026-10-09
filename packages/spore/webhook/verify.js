import { createHmac, timingSafeEqual } from 'node:crypto'

const same = (given, expected) => {
  const a = Buffer.from(String(given))
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const hmac = (algorithm, secret, data, encoding) => createHmac(algorithm, secret).update(data).digest(encoding)

function stripe (check, header, body, now) {
  const parts = header.split(',').map(part => part.split('='))
  const t = parts.find(([key]) => key === 't')?.[1]
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value)
  if (!t || !signatures.length) return `${check.header} has no t= or v1=`
  if (Math.abs(now / 1000 - Number(t)) > check.tolerance) return `${check.header} was signed at ${t}, outside ${check.tolerance} s of now`
  const expected = hmac('sha256', check.secret, Buffer.concat([Buffer.from(`${t}.`), body]), 'hex')
  return signatures.some(signature => same(signature, expected)) ? null : 'the signature does not match'
}

/**
 * Null when the request is the sender's, else why not — for the service's log, never for the
 * caller, who is told 401 and nothing more.
 */
export function verify (check, { headers, body, token, now = Date.now() }) {
  if (check.method === 'path') {
    if (token === undefined) return 'no token in the path'
    return same(token, check.secret) ? null : 'the path token does not match'
  }
  const header = headers[check.header]
  if (typeof header !== 'string') return `no ${check.header} header`
  if (check.method === 'header') return same(header, check.secret) ? null : `${check.header} does not match`
  if (check.method === 'stripe') return stripe(check, header, body, now)
  const expected = check.prefix + hmac(check.algorithm, check.secret, body, check.encoding)
  return same(header, expected) ? null : 'the signature does not match'
}
