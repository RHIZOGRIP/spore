/**
 * Watching a turn that is not this process.
 *
 * A turn takes no interactive input, so attaching to one is following two files rather
 * than sharing a terminal: the runner's streams go to `spore.out` and `spore.err`.
 *
 * They stay two files because the answer is stdout and mixing them would make it
 * unparseable — `spore send … > answer.txt` has to keep working. While stderr is a terminal, one
 * line on it shows the running turn — `live`'s default rendering, cleared before anything else
 * is written and drawn again after.
 */

import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs'

import { ERR_FILE, OUT_FILE, readEvents } from '../core/spore-dir.js'
import { stateOf, RUNNING } from '../core/state.js'
import { applyEvent, liveIn, renderLive } from './live.js'

const TICK_MS = 150
const STATUS_EVERY_MS = 500

/** The default rendering on one line of a terminal `width` wide, at `details`: the operator's own machine. */
export function statusLine (live, { width = 80 } = {}) {
  const line = renderLive(live, { level: 'details', now: Date.now() }).map(part => part.replace(/^· /, '')).join(' · ')
  return line.length < width ? line : `${line.slice(0, Math.max(0, width - 2))}…`
}

const NEWLINE = 0x0a
const continuation = (byte) => (byte & 0xc0) === 0x80

/**
 * The byte to start reading at so that the last `lines` are shown and no more. Counted in
 * bytes: a newline byte never occurs inside a UTF-8 sequence, so the byte after one starts a
 * character, and a window with fewer newlines is moved past the continuation bytes it begins
 * with. A newline ending the file ends the last line rather than starting an empty one.
 */
export function tailFrom (path, lines) {
  if (!existsSync(path)) return 0
  const size = statSync(path).size
  if (!lines || !size) return size
  const want = Math.min(size, 64 * 1024)
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(want)
    readSync(fd, buf, 0, want, size - want)
    let at = buf[want - 1] === NEWLINE ? want - 1 : want
    for (let seen = 0; seen < lines; seen++) {
      const next = at > 0 ? buf.lastIndexOf(NEWLINE, at - 1) : -1
      if (next === -1) {
        let start = 0
        while (start < want && continuation(buf[start])) start++
        return size - want + start
      }
      at = next
    }
    return size - want + at + 1
  } finally {
    closeSync(fd)
  }
}

const readFrom = (path, at) => {
  if (!existsSync(path)) return { bytes: null, at }
  const size = statSync(path).size
  if (size <= at) return { bytes: null, at }
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(size - at)
    readSync(fd, buf, 0, buf.length, at)
    return { bytes: buf, at: size }
  } finally {
    closeSync(fd)
  }
}

/**
 * Follow until the turn ends, or until the caller detaches. Detaching costs the turn
 * nothing: the runner was spawned detached and unrefed, so quitting here kills nothing.
 *
 * @returns {'ended'|'detached'}
 */
export async function follow (ws, { lines = 0, out = process.stdout, err = process.stderr, tick = TICK_MS, grace = 5000, status = false } = {}) {
  const streams = [
    { path: `${ws}/${OUT_FILE}`, to: out },
    { path: `${ws}/${ERR_FILE}`, to: err }
  ].map(s => ({ ...s, at: tailFrom(s.path, lines), decoder: new TextDecoder('utf-8') }))

  const quit = { detached: false }
  const detach = () => { quit.detached = true }
  process.on('SIGINT', detach)

  const showing = status && err.isTTY === true
  let shown = null
  let drawn = ''
  let drawnAt = 0
  const clear = () => {
    if (!drawn) return
    err.write('\r\x1b[K')
    drawn = ''
  }
  const draw = () => {
    if (!showing || Date.now() - drawnAt < STATUS_EVERY_MS) return
    drawnAt = Date.now()
    shown ??= liveIn(ws)
    if (!shown) return
    for (const event of readEvents(ws, { after: shown.seq })) {
      shown.seq = event.seq
      if (event.event === 'turn_end') {
        shown = null
        return clear()
      }
      applyEvent(shown.live, event)
    }
    const line = statusLine(shown.live, { width: err.columns })
    if (line === drawn) return
    err.write(`\r\x1b[K${line}`)
    drawn = line
  }

  // One decoder per stream, kept across reads: the runner writes while this reads, and a read
  // can end partway through a character.
  const drain = () => {
    for (const stream of streams) {
      const got = readFrom(stream.path, stream.at)
      stream.at = got.at
      if (!got.bytes) continue
      const text = stream.decoder.decode(got.bytes, { stream: true })
      if (!text) continue
      clear()
      drawnAt = 0
      stream.to.write(text)
    }
  }

  // Liveness is the lock, as everywhere else: the kernel drops it when the holder dies,
  // so a turn that crashed ends this the same way one that answered does. The grace
  // window is for the other end of it — a runner spawned a moment ago has not taken the
  // lock yet, and a workspace that never ran has no lock file at all, so "not running"
  // cannot mean "over" until one has been seen.
  const deadline = Date.now() + grace
  let started = false
  try {
    while (!quit.detached) {
      drain()
      const running = stateOf(ws).state === RUNNING
      if (running) started = true
      else if (started || Date.now() > deadline) break
      draw()
      await new Promise(resolve => setTimeout(resolve, tick))
    }
    clear()
    drain()
    for (const stream of streams) {
      const rest = stream.decoder.decode()
      if (rest) stream.to.write(rest)
    }
    return quit.detached ? 'detached' : 'ended'
  } finally {
    process.off('SIGINT', detach)
  }
}
