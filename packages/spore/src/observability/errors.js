/**
 * `SporeError` — the one error kind. It is flat on purpose: `type` is the machine tag
 * callers branch on, `message` a short human-readable label, `detail` the explanatory
 * text, plus `severity` (lowercase string) and `retryable`.
 *
 * Thrown in-process and serialized onto a wire are two transports for the same error.
 * `toJSON()` whitelists the wire fields, so in-process-only state (`context`) cannot
 * reach one.
 *
 * Field-compatible with mohdel's `MohdelError`, so a mohdel error crossing
 * into spore needs no translation — both are branched on by `type`.
 */

/** @typedef {('trace'|'debug'|'info'|'warn'|'error'|'fatal')} SeverityTag */

export const SEVERITY_TAGS = Object.freeze([
  'trace', 'debug', 'info', 'warn', 'error', 'fatal'
])

/** An error as one line: its message, then its detail when it has one. */
export const errorText = (err) => [err.message, err.detail].filter(Boolean).join(' — ')

export class SporeError extends Error {
  /**
   * @param {string} message  Short human-readable label. Not a machine key.
   * @param {{
   *   severity?: SeverityTag,
   *   retryable?: boolean,
   *   detail?: string,
   *   type?: string,
   *   retryAfterMs?: number,
   *   context?: object,
   *   cause?: unknown
   * }} [options]
   *   `context` is in-process only and never serialized. `retryAfterMs` is how long until the
   *   same call can succeed, when the refusal said.
   */
  constructor (message, { severity = 'error', retryable = false, detail, type, retryAfterMs, context, cause } = {}) {
    super(message, { cause })
    this.name = 'SporeError'
    this.severity = severity
    this.retryable = retryable
    if (detail) this.detail = detail
    if (type) this.type = type
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs
    if (context) this.context = context
  }

  toJSON () {
    const out = {
      message: this.message,
      severity: this.severity,
      retryable: this.retryable
    }
    if (this.detail) out.detail = this.detail
    if (this.type) out.type = this.type
    if (this.retryAfterMs !== undefined) out.retryAfterMs = this.retryAfterMs
    return out
  }

  /**
   * @param {object} data   Wire error object.
   * @param {object} [context]  In-process only; not part of `data`.
   */
  static fromJSON (data, context) {
    return new SporeError(data.message, {
      severity: data.severity,
      retryable: data.retryable,
      detail: data.detail,
      type: data.type,
      retryAfterMs: data.retryAfterMs,
      context
    })
  }
}

/**
 * Project any error — typed or plain — onto the wire shape. Plain `Error`
 * instances are redacted: their message may carry internals.
 *
 * @param {Error|SporeError} err
 * @param {object} [span]  OTel span; when given, `out.trace` is its traceId.
 */
export function toWireError (err, span) {
  const isTyped = err && typeof err === 'object' && typeof err.toJSON === 'function'
  const out = isTyped
    ? err.toJSON()
    : {
        message: 'unexpected error',
        detail: 'An unexpected error occurred',
        severity: 'error',
        retryable: false,
        type: 'UNEXPECTED_ERROR'
      }
  if (span && typeof span.spanContext === 'function') {
    const ctx = span.spanContext()
    if (ctx && ctx.traceId) out.trace = ctx.traceId
  }
  return out
}
