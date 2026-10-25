import { trace, context, SpanStatusCode } from '@opentelemetry/api'

// Lazy, and dropped on SDK init, so a no-op tracer retrieved before init is not pinned for
// the process's lifetime.
let tracer
const getTracer = () => (tracer ??= trace.getTracer('spore'))
const resetTracer = () => { tracer = undefined }

let otelInitialized = false
let otelSdk = null

// Hard ceiling on OTel init. Telemetry is observability, not
// correctness; never let a slow/stuck SDK block worker readiness or
// envelope handling. Configurable via env for environments with
// pathologically slow ESM cold-load (e.g. some staging hosts).
const OTEL_INIT_TIMEOUT_MS = Number(process.env.OTEL_INIT_TIMEOUT_MS) || 5000

/**
 * OTel SDK setup for the processes spore starts that open spans — the agent, a cell's agent,
 * the API — each of which exports its own. Called at the top of each one's main.
 *
 * No-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is absent; when the SDK
 * packages cannot be loaded, init fails with a warning and spans stay
 * no-ops.
 */
export async function ensureOtelInitialized () {
  if (otelInitialized) return
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!endpoint) { otelInitialized = true; return }

  const init = (async () => {
    const [{ NodeSDK }, { OTLPTraceExporter }] = await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/exporter-trace-otlp-grpc')
    ])
    otelSdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter({ url: endpoint }),
      serviceName: process.env.OTEL_SERVICE_NAME || 'spore-worker'
    })
    otelSdk.start()
    otelInitialized = true
    // Drop the cached no-op tracer so subsequent startSpan() picks up
    // the now-registered SDK's tracer.
    resetTracer()
  })().catch(e => {
    // Swallow late-arriving init failure — the timeout path may have
    // already resolved race(); an uncaught rejection here would crash
    // the worker. Logged so operators see it.
    process.stderr.write(
      `${JSON.stringify({ level: 'warn', time: Date.now(), subsystem: 'spore:tracing', msg: 'OTel SDK init failed (late)', err: { message: e.message } })}\n`
    )
  })

  let timer
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      process.stderr.write(
        `${JSON.stringify({ level: 'warn', time: Date.now(), subsystem: 'spore:tracing', msg: 'OTel SDK init exceeded timeout — proceeding without span export', timeoutMs: OTEL_INIT_TIMEOUT_MS })}\n`
      )
      resolve()
    }, OTEL_INIT_TIMEOUT_MS)
    timer?.unref?.()
  })

  try {
    await Promise.race([init, timeout])
  } catch (e) {
    process.stderr.write(
      `${JSON.stringify({ level: 'warn', time: Date.now(), subsystem: 'spore:tracing', msg: 'OTel SDK init failed', err: { message: e.message } })}\n`
    )
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Flush + shut down the OTel SDK before the process exits. Without this
 * the `BatchSpanProcessor` buffer is discarded at `process.exit`,
 * which silently drops every span the process emitted — including the
 * `spore.dispatch` span its model calls name as their parent. Result: a
 * trace backend shows those calls with a missing parent, detached from
 * the caller's trace.
 *
 * Idempotent + swallows errors — called from `finally` blocks in
 * exit paths, must never mask the real termination reason.
 */
export async function shutdownOtel (timeoutMs = 3000) {
  if (!otelSdk) return
  const sdk = otelSdk
  otelSdk = null
  try {
    await Promise.race([
      sdk.shutdown(),
      new Promise((resolve) => setTimeout(resolve, timeoutMs))
    ])
  } catch (e) {
    process.stderr.write(
      `${JSON.stringify({ level: 'warn', time: Date.now(), subsystem: 'spore:tracing', msg: 'OTel SDK shutdown failed', err: { message: e.message } })}\n`
    )
  }
}

export const startSpan = (name, attributes, parentSpan) => {
  const parentCtx = parentSpan
    ? trace.setSpan(context.active(), parentSpan)
    : undefined
  return getTracer().startSpan(name, { attributes }, parentCtx)
}

export const endSpanOk = (span, attributes) => {
  if (attributes) span.setAttributes(attributes)
  span.setStatus({ code: SpanStatusCode.OK })
  span.end()
}

export const endSpanError = (span, err) => {
  span.recordException(err)
  span.setStatus({ code: SpanStatusCode.ERROR, message: err.message })
  span.end()
}

// W3C Trace Context — https://www.w3.org/TR/trace-context/#traceparent-header
// Format: 00-<traceId>-<spanId>-<traceFlags> (lowercase hex). Used by the model client so
// trace context can cross the unix-socket process boundary as a header
// instead of trying to serialize a live span object (which has circular OTel internals).
const INVALID_TRACE_ID = '00000000000000000000000000000000'
const INVALID_SPAN_ID = '0000000000000000'

/**
 * Format a span as a W3C `traceparent` header string.
 * Returns null if the input is missing, has no spanContext, or contains invalid all-zero IDs.
 */
export const formatTraceparent = (span) => {
  if (!span || typeof span.spanContext !== 'function') return null
  const ctx = span.spanContext()
  if (!ctx?.traceId || !ctx?.spanId) return null
  if (ctx.traceId === INVALID_TRACE_ID) return null
  if (ctx.spanId === INVALID_SPAN_ID) return null
  const flags = (ctx.traceFlags ?? 0).toString(16).padStart(2, '0')
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`
}

/**
 * Project an OTel span (live or remote-wrapper) to the log payload
 * shape `{ traceId, spanId, traceFlags }` — the hex fields OTel's own
 * span context names — so a log line joins its trace on trace-id in
 * any log or trace pipeline, alongside other services' logs that use
 * the same fields.
 *
 * Safe for loggers: real OTel spans carry circular references
 * (`BatchSpanProcessor` → `BindOnceFuture` cycles) that break
 * `JSON.stringify`; this helper extracts just the hex fields so the
 * live span never reaches a serializer. Returns `null` when the span
 * is absent or can't yield a context — callers attach conditionally.
 */
export const serializeSpanContext = (span) => {
  try {
    const ctx = span && typeof span.spanContext === 'function' ? span.spanContext() : span
    if (!ctx || typeof ctx !== 'object') return null
    const p = {}
    if (ctx.traceId) p.traceId = ctx.traceId
    if (ctx.spanId) p.spanId = ctx.spanId
    if (ctx.traceFlags !== undefined) p.traceFlags = ctx.traceFlags
    return Object.keys(p).length ? p : null
  } catch {
    return null
  }
}

/**
 * Parse a W3C `traceparent` header into a non-recording span usable as
 * the `parentSpan` argument to `startSpan`. Returns null if the header
 * is absent, malformed, or contains invalid all-zero IDs.
 */
export const parseTraceparent = (headerStr) => {
  if (typeof headerStr !== 'string' || headerStr.length === 0) return null
  const parts = headerStr.split('-')
  if (parts.length !== 4) return null
  const [version, traceId, spanId, flagsHex] = parts
  if (version !== '00') return null
  if (!/^[0-9a-f]{32}$/.test(traceId) || traceId === INVALID_TRACE_ID) return null
  if (!/^[0-9a-f]{16}$/.test(spanId) || spanId === INVALID_SPAN_ID) return null
  const traceFlags = Number.parseInt(flagsHex, 16)
  if (!Number.isFinite(traceFlags)) return null
  return trace.wrapSpanContext({
    traceId,
    spanId,
    traceFlags,
    isRemote: true
  })
}
