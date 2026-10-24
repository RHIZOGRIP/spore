/**
 * Logger interface — { trace, debug, info, warn, error, fatal, child }
 *
 * Same shape as mohdel + pino expects. CLI picks between:
 *   - `cliLogger` for interactive terminals (human-readable console.error)
 *   - `jsonLogger` for pipes/subprocesses (pino-shaped JSON → stderr)
 * Library callers inject their own, typically a pino logger.
 *
 * `.child(bindings)` returns a logger of the same shape with extra context bound.
 * For pino, this is native. For `silent` and `cliLogger`, it's a no-op that
 * returns the same logger — bindings aren't propagated since those loggers don't
 * structure output anyway. For `jsonLogger`, `.child(bindings)` returns a new
 * logger with `bindings` merged into every emitted entry — the minimum needed
 * to let callers tag subprocess output (e.g. `{ subprocess: 'spawn' }`).
 */

const noop = () => {}

function silentChild () { return silent }

export const silent = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  fatal: noop,
  child: silentChild
}

export function cliLogger (debug = false) {
  const lg = {
    trace: noop,
    debug: debug ? (...a) => console.error(...a) : noop,
    info: debug ? (...a) => console.error(...a) : noop,
    warn: (...a) => console.error(...a),
    error: (...a) => console.error(...a),
    fatal: (...a) => console.error(...a),
    child: () => lg
  }
  return lg
}

// Zero-dep pino-compatible JSON logger for CLI subprocess usage. Writes one
// JSON object per line to stderr. Shape matches pino's default output so log
// aggregators that parse pino handle it without special casing.
//
// Level numbers follow pino:
//   trace=10, debug=20, info=30, warn=40, error=50, fatal=60
const LEVEL_NUMBERS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }

function serializeEntry (levelName, bindings, arg, msg) {
  const entry = {
    level: LEVEL_NUMBERS[levelName],
    time: Date.now(),
    ...bindings
  }
  if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
    Object.assign(entry, arg)
    if (msg !== undefined) entry.msg = String(msg)
  } else if (msg !== undefined) {
    entry.msg = String(msg)
    if (arg !== undefined) entry.detail = typeof arg === 'string' ? arg : safeStringify(arg)
  } else if (arg !== undefined) {
    entry.msg = typeof arg === 'string' ? arg : safeStringify(arg)
  }
  return entry
}

function safeStringify (obj) {
  try { return JSON.stringify(obj) } catch { return String(obj) }
}

// A field nobody can serialize costs the fields, never the line: what happened is still said.
function write (entry) {
  let line
  try {
    line = JSON.stringify(entry)
  } catch (err) {
    line = JSON.stringify({ level: entry.level, time: entry.time, msg: entry.msg, unlogged: `its fields could not be written: ${err.message.split('\n')[0]}` })
  }
  process.stderr.write(line + '\n')
}

export function jsonLogger ({ level = 'debug', bindings = {} } = {}) {
  const threshold = LEVEL_NUMBERS[level] ?? LEVEL_NUMBERS.debug
  const make = (levelName) => {
    if (LEVEL_NUMBERS[levelName] < threshold) return noop
    return (arg, msg) => write(serializeEntry(levelName, bindings, arg, msg))
  }
  const lg = {
    trace: make('trace'),
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    fatal: make('fatal'),
    child: (extra = {}) => jsonLogger({ level, bindings: { ...bindings, ...extra } })
  }
  return lg
}

// Helper for CLIs: pick the right logger based on output context.
//   - LOG_FORMAT=json  → always JSON
//   - piped stderr     → JSON (subprocess use, log pipeline expects structured)
//   - interactive TTY  → cliLogger (human-readable)
// Both keep info quiet unless debug; LOG_LEVEL overrides the JSON one.
export function autoLogger ({ debug = false } = {}) {
  const format = process.env.LOG_FORMAT
  if (format === 'json' || (format !== 'human' && !process.stderr.isTTY)) {
    return jsonLogger({ level: process.env.LOG_LEVEL || (debug ? 'debug' : 'warn') })
  }
  return cliLogger(debug)
}
