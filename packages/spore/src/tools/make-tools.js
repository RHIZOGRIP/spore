import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve, dirname, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { safePath, hasDotSegment } from '../isolation/safe-path.js'
import { CALLS_DIR, DATA_DIR, PRECURSOR_DIR, TMP_DIR, turnTmpOf, writableDirs } from '../core/spore-dir.js'
import { SCHEDULE_DIR, refuseScheduleWrite, scheduleDir } from '../core/schedule.js'
import { CONFINE_BIN, runShell } from '../core/command.js'
import { contextView, dropIfEmpty, fileRecord, hashFile, recorded } from '../core/call-record.js'
import { isRefusal, refuse } from '../core/refusal.js'
import { SNIFF_BYTES, sniffImage } from '../core/media.js'

async function readHead (absPath, n) {
  const chunks = []
  for await (const chunk of createReadStream(absPath, { start: 0, end: n - 1 })) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function readBytes (absPath, { offset, length, encoding, size }) {
  if (offset >= size || length === 0) return { text: '', bytesRead: 0, eof: offset >= size }
  const chunks = []
  for await (const chunk of createReadStream(absPath, { start: offset, end: offset + length - 1 })) chunks.push(chunk)
  const buf = Buffer.concat(chunks)
  return {
    text: new TextDecoder(encoding, { fatal: true }).decode(buf),
    bytesRead: buf.length,
    eof: offset + buf.length >= size
  }
}

const numberLines = (text, first) => (text === '' ? '' : text.split(/(?<=\n)/).map((line, i) => `${first + i}→${line}`).join(''))

async function readLines (absPath, { offset, length, encoding, budget, size }) {
  const decoder = new TextDecoder(encoding, { fatal: true })
  const stream = createReadStream(absPath)
  const lines = []
  let pending = ''
  let seen = 0
  let chars = 0
  let over = false
  let eof = true
  let bytes = 0

  for await (const chunk of stream) {
    bytes += chunk.length
    pending += decoder.decode(chunk, { stream: true })
    let cut = pending.indexOf('\n')
    while (cut !== -1) {
      seen += 1
      if (seen >= offset) {
        const line = pending.slice(0, cut + 1)
        chars += line.length
        if (chars > budget) { over = true; break }
        lines.push(line)
      }
      pending = pending.slice(cut + 1)
      if (length && lines.length >= length) { eof = false; break }
      cut = pending.indexOf('\n')
    }
    if (over || (length && lines.length >= length)) { stream.destroy(); break }
  }

  if (!over && (!length || lines.length < length)) {
    pending += decoder.decode()
    if (pending.length) {
      seen += 1
      if (seen >= offset) {
        chars += pending.length
        if (chars > budget) over = true
        else lines.push(pending)
      }
    }
  }

  if (!eof) eof = !pending.length && bytes >= size && !decoder.decode().length

  return { text: lines.join(''), returned: lines.length, lastLine: seen, over, eof }
}

const EXEC_TIMEOUT_MS = 30000
const EXEC_TIMEOUT_MAX_MS = 3600000
const EXEC_IDLE_MS = 120000

const SPORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SPAWN_BIN = resolve(SPORE_ROOT, 'native', 'spore-spawn')
const FANOUT_BIN = resolve(SPORE_ROOT, 'bin', 'fanout.js')
const RECALL_BIN = resolve(SPORE_ROOT, 'bin', 'recall.js')
const SOURCE_BIN = resolve(SPORE_ROOT, 'bin', 'source.js')
const JOB_BIN = resolve(SPORE_ROOT, 'bin', 'job.js')
const SQL_BIN = resolve(SPORE_ROOT, 'bin', 'sql.js')

/**
 * Every call leaves a record, refusals included.
 *
 * A tool that rejects its arguments answers before it opens a record, and one that
 * rejects a path does it by throwing — so the trail used to hold only the calls that
 * got far enough to run, and disagreed with the transcript about what the agent tried.
 * One wrapper rather than a `trail.begin` in front of every validation.
 *
 * Every tool validates before `trail.begin`, and the budget paths `abandon` before
 * returning, so a refusal always means nothing was written down.
 */
export function recordRefusals (fns, trail) {
  const recording = (tool, fn) => async (args, ctx) => {
    let result
    try {
      result = await fn(args, ctx)
    } catch (err) {
      // `safePath` refuses by throwing. The kernel's own catch turned that into a
      // result nothing recorded, and told the agent "absolute path rejected" — the
      // rule it broke rather than what to do instead.
      result = refuse(err.detail || err.message)
    }
    if (isRefusal(result)) trail.refuse(tool, { args, error: result.refused })
    return result
  }
  return Object.fromEntries(Object.entries(fns).map(([name, fn]) => [name, recording(name, fn)]))
}

export function makeTools (WS, maxOutput, trail, {
  modelId = null,
  traceparent = null,
  modelSocket = null,
  storeSocket = null,
  sourceSocket = null,
  reads = [],
  writes = [],
  pluginReads = [],
  images = null,
  // The root definition's `schedules: [count, interval]`. Granted, `schedules/` is a write
  // island and every file written there is checked against it; absent, the directory is
  // the operator's.
  schedules = null,
  unanswered = () => null
} = {}) {
  // Intake for this turn, against the definition's `images` pair. Counted here because
  // `makeTools` is built once per turn, which is the span the bound is declared over.
  const looked = { count: 0, bytes: 0 }
  const readRoots = reads.map(r => r.path)
  const writeRoots = writes.map(w => w.path)
  const safe = (p) => safePath(WS, p, { reads: [...readRoots, ...writeRoots] })
  const scheduled = scheduleDir(WS)
  const islands = [...writableDirs(WS), ...(schedules ? [scheduled] : []), ...writeRoots]
  const under = (abs, dir) => abs === dir || abs.startsWith(dir + sep)
  // The workspace root is read-only to the agent, so a path outside the islands
  // would fail as a bare EACCES several rounds later.
  const callsDir = resolve(WS, CALLS_DIR)
  const tmp = turnTmpOf(trail.root)
  // `calls/` is writable for the streams the runtime names itself and for the turn's `tmp/`; any other path the agent names there is refused.
  const runtimes = (abs) => under(abs, callsDir) && !under(abs, tmp) ? refuse(`${CALLS_DIR}/ is the runtime's, where the streams of a call that named none land — write under ${DATA_DIR}/`) : null
  const unwritable = (abs) => {
    if (islands.some(d => under(abs, d))) return null
    const corpus = reads.find(r => under(abs, r.path))
    if (corpus) return refuse(`${corpus.name}/ is a corpus this spore reads and never writes — write under ${DATA_DIR}/`)
    if (under(abs, scheduled)) {
      return refuse(`${SCHEDULE_DIR}/ is written by whoever runs this spore — its definition grants no schedules, so you can read what you are scheduled to do and not change it`)
    }
    return refuse(`${relative(WS, abs) || '.'} is not writable — the workspace root holds the runtime's own files; write under ${DATA_DIR}/`)
  }
  // A schedule is checked before it is written, so a bad one is refused in the call that
  // made it rather than held, unexplained, by a pass the agent never sees.
  const unscheduled = (abs, content) => {
    const reason = schedules && under(abs, scheduled) ? refuseScheduleWrite(WS, abs, content, { grant: schedules }) : null
    return reason ? refuse(reason) : null
  }

  // `target` is the argument naming the file this call is about: `path` for the tools
  // that act on one, `out` for the tools that redirect a stream into one.
  const checkTargets = (args, { target = 'out', outRequired = true, accepts } = {}) => {
    const { err, in: inPath } = args
    const out = args[target]
    const stray = accepts ? Object.keys(args).filter(k => !accepts.includes(k)) : []
    if (stray.length) {
      return refuse(`unexpected parameter ${stray.map(k => `"${k}"`).join(', ')} — this tool takes ${accepts.join(', ')}`)
    }
    if (outRequired && !out) return refuse(`${target} is required — name a workspace path`)
    for (const [label, p] of [['out', out], ['err', err], ['in', inPath]]) {
      if (p && hasDotSegment(p, WS)) return refuse(`${label} cannot be a dotfile or dotdir`)
    }
    return null
  }

  // Anything that fails between begin() and finish() would leave a call
  // directory with no record in it, which the trail then reports as a call that
  // never happened.
  const openTargets = (tool, { out, err }) => {
    const call = trail.begin(tool)
    try {
      const outAbs = out ? safe(out) : trail.autoPath(call, 'out')
      const errAbs = err ? safe(err) : trail.autoPath(call, 'err')
      const denied = (out && runtimes(outAbs)) || (err && runtimes(errAbs)) || unwritable(outAbs)
      if (denied) {
        trail.abandon(call)
        return { refusal: denied }
      }
      // `err` names a file too, and it was the only target not checked against the
      // islands — so a bad one reached `openSync` and came back as a raw EACCES quoting
      // an absolute host path, where the same mistake in `path` gets a sentence saying
      // what to do instead. Measured on a memory benchmark: twelve of twelve models put
      // a *message* in `err` ("Could not save notes"), and every one of them was told
      // `EACCES: permission denied, open '/home/…/06878be2/Could not save notes'`.
      if (err && unwritable(errAbs)) {
        trail.abandon(call)
        return { refusal: refuse(`err is where the failure message is written, not the message itself — "${err}" is not a path under ${DATA_DIR}/`) }
      }
      mkdirSync(dirname(outAbs), { recursive: true })
      mkdirSync(dirname(errAbs), { recursive: true })
      return { call, outAbs, errAbs }
    } catch (e) {
      trail.abandon(call)
      throw e
    }
  }

  // A write `exec` was refused reads, to the model, as a directory that cannot be written,
  // and it gives up with the result in hand. The refusal is exec's, so the result says so,
  // where the model is looking — only when the error names a place it could have written.
  const refusedWrite = (errAbs) => {
    if (!existsSync(errAbs)) return false
    const text = readFileSync(errAbs, 'utf8').slice(-65536)
    if (!/EACCES|EROFS|Permission denied|PermissionError|Read-only file system/.test(text)) return false
    return [DATA_DIR, PRECURSOR_DIR, ...(schedules ? [SCHEDULE_DIR] : []), ...writes.map(w => w.name)].some(dir => text.includes(`${dir}/`) || text.includes(`'${dir}'`) || text.includes(`"${dir}"`) || text.includes(resolve(WS, dir))) ||
      writeRoots.some(root => text.includes(root))
  }

  const runCommand = async ({ tool, command, inPath, out, err, confined, timeoutMs, idleMs, sig }) => {
    const inAbs = inPath ? safe(inPath) : null
    if (inAbs && !existsSync(inAbs)) return refuse(`in not found — ${inPath}`)

    const targets = openTargets(tool, { out, err })
    if (targets.refusal) return targets.refusal
    const { call, outAbs, errAbs } = targets
    mkdirSync(tmp, { recursive: true })

    const ran = await runShell({
      command,
      cwd: WS,
      inAbs,
      outAbs,
      errAbs,
      confine: confined ? { writeRoot: tmp, reads: [...readRoots, ...writeRoots, ...pluginReads, WS] } : null,
      // W3C trace context, by the environment because that is the only channel a
      // subprocess shares with us. A spawned cell picks it up and makes its own
      // dispatch span a child of this one, which is what joins a fan-out into one
      // trace instead of fifty roots.
      env: { ...process.env, TMPDIR: tmp, SPORE_SPAWN: SPAWN_BIN, SPORE_FANOUT: FANOUT_BIN, SPORE_RECALL: RECALL_BIN, SPORE_SOURCE: SOURCE_BIN, SPORE_SQL: SQL_BIN, SPORE_JOB: JOB_BIN, MODEL: modelId || process.env.MODEL, ...(traceparent ? { TRACEPARENT: traceparent } : {}), ...(modelSocket ? { SPORE_MODEL_SOCKET: modelSocket } : {}), ...(storeSocket ? { SPORE_STORE_SOCKET: storeSocket } : {}), ...(sourceSocket ? { SPORE_SOURCE_SOCKET: sourceSocket } : {}) },
      timeoutMs,
      idleMs,
      signal: sig
    })

    const hint = confined && ran.exit !== 0 && refusedWrite(errAbs)
      ? `exec is read-only: nothing it runs can write but ${TMP_DIR}/. ${[DATA_DIR, PRECURSOR_DIR, ...writes.map(w => w.name)].map(dir => `${dir}/`).join(', ')} are writable — make the same write with write, edit or wsexec.`
      : null

    // The runtime removes only what the runtime named; a caller-named path
    // stays even when empty, because its emptiness is a fact about the run.
    if (!out) dropIfEmpty(outAbs)
    if (!err) dropIfEmpty(errAbs)

    return recorded(contextView(trail.finish(call, {
      command,
      exit: ran.exit,
      signal: ran.signal,
      killed: ran.killed,
      timeoutMs,
      idleMs,
      lastProgressAt: new Date(ran.lastProgressAt).toISOString(),
      ...(ran.spawnError ? { spawnError: ran.spawnError } : {}),
      ...(hint ? { hint } : {}),
      files: {
        in: inAbs ? await fileRecord(inAbs, { workspace: WS }) : null,
        out: await fileRecord(outAbs, { workspace: WS }),
        err: await fileRecord(errAbs, { workspace: WS })
      }
    })))
  }

  const fns = {
    read: async ({ path, offset, length, encoding, unit, numbered }) => {
      if (hasDotSegment(path, WS)) return refuse('cannot read dotfiles or dotdirs')
      // A model that fills every field sends "" for the ones it does not mean to use.
      const given = Object.entries({ offset, length, encoding, unit, numbered }).filter(([, value]) => value !== undefined && value !== '').map(([name]) => name)
      encoding = encoding || 'utf-8'
      unit = unit || 'lines'
      numbered = numbered || false
      if (typeof numbered !== 'boolean') return refuse(`numbered is true or false — got ${JSON.stringify(numbered)}`)
      const abs = safe(path)
      if (!existsSync(abs)) return refuse(`not found — ${path}`)
      const st = statSync(abs)

      // Decided by the first bytes, not the extension: a downloaded file is named by
      // whatever the URL ended in, or by nothing.
      const mime = sniffImage(await readHead(abs, SNIFF_BYTES))
      if (mime) {
        if (!images) {
          return refuse(`${path} is an image (${mime}), and this spore is not granted images — its definition needs an images: [count, size] line before it can look at one`)
        }
        if (looked.count >= images.count) {
          return refuse(`${images.count} image(s) is all this turn may look at — the rest of the work has to happen without another, or in the next turn`)
        }
        if (looked.bytes + st.size > images.bytes) {
          return refuse(`${path} is ${st.size} bytes and this turn has ${images.bytes - looked.bytes} of its ${images.bytes} byte image budget left`)
        }
        const call = trail.begin('read')
        const observed = {
          path: relative(WS, abs),
          bytes: st.size,
          mime,
          hash: await hashFile(abs),
          ...(given.length ? { ignored: given } : {})
        }
        looked.count += 1
        looked.bytes += st.size
        return recorded(contextView(trail.finish(call, observed)), [{ fileUri: pathToFileURL(abs).href, mimeType: mime }])
      }
      if (unit !== 'lines' && unit !== 'bytes') return refuse(`unit must be lines or bytes — got ${unit}`)
      if (numbered && unit === 'bytes') return refuse('numbered counts lines — it does not apply to a read by bytes')
      // What the model receives is the whole record, not the slice of file inside it.
      // Budgeting only the content let a read that just fit come back as a record over
      // budget, which the transcript sanitiser then cut mid-JSON. Measured here, before
      // the call is written down, so a refusal leaves no record claiming it happened.
      const common = async (call, extra) => {
        const observed = {
          path: relative(WS, abs),
          encoding,
          unit,
          bytes: st.size,
          hash: await hashFile(abs),
          ...extra
        }
        const view = contextView(trail.preview(call, observed))
        const shown = JSON.stringify(view).length
        if (shown > maxOutput) {
          trail.abandon(call)
          return refuse(`that range of ${path} comes back as ${shown} characters, over the ${maxOutput} budget — ask for fewer`)
        }
        trail.finish(call, observed)
        return recorded(view)
      }

      if (unit === 'bytes') {
        const start = offset ?? 0
        const want = length ?? Math.max(st.size - start, 0)
        if (want > maxOutput) {
          return refuse(`${want} bytes is over the ${maxOutput} byte read budget — ask for fewer, or use unit lines`)
        }
        const call = trail.begin('read')
        try {
          const slice = await readBytes(abs, { offset: start, length: want, encoding, size: st.size })
          return await common(call, { offset: start, bytesRead: slice.bytesRead, eof: slice.eof, content: slice.text })
        } catch (e) {
          trail.abandon(call)
          return refuse(`bytes ${start}..${start + want} of ${path} do not decode as ${encoding} — the range may split a multi-byte character`)
        }
      }

      const start = offset ?? 1
      if (!length && st.size > maxOutput) {
        return refuse(`${path} is ${st.size} bytes, over the ${maxOutput} byte read budget — pass offset and length, or read it with unit bytes`)
      }

      const call = trail.begin('read')
      let slice
      try {
        slice = await readLines(abs, { offset: start, length, encoding, budget: maxOutput, size: st.size })
      } catch (e) {
        trail.abandon(call)
        return refuse(`${path} does not decode as ${encoding} — ${e.message}`)
      }
      if (slice.over) {
        trail.abandon(call)
        return refuse(`lines ${start}..${start + slice.returned} of ${path} exceed the ${maxOutput} byte read budget — ask for fewer lines`)
      }

      return await common(call, { offset: start, lines: slice.returned, eof: slice.eof, ...(numbered ? { numbered, content: numberLines(slice.text, start) } : { content: slice.text }) })
    },
    write: async ({ content, path, err, ...rest }) => {
      if (typeof content !== 'string') return refuse('content is required and must be a string')
      const bad = checkTargets({ content, path, err, ...rest }, { target: 'path', accepts: ['content', 'path', 'err'] })
      if (bad) return bad
      const denied = runtimes(safe(path)) || unwritable(safe(path)) || unscheduled(safe(path), content)
      if (denied) return denied
      const targets = openTargets('write', { out: path, err })
      if (targets.refusal) return targets.refusal
      const { call, outAbs, errAbs } = targets

      let exit = 1
      let errText = ''
      try {
        writeFileSync(outAbs, content)
        exit = 0
      } catch (e) {
        errText = `${e.message}\n`
      }
      writeFileSync(errAbs, errText)
      if (!err) dropIfEmpty(errAbs)

      const view = contextView(trail.finish(call, {
        exit,
        files: {
          out: await fileRecord(outAbs, { workspace: WS }),
          err: await fileRecord(errAbs, { workspace: WS })
        }
      }))
      // The caller wrote these bytes. Handing them back is telling it what it just
      // said, and the transcript then carries the file twice — once in the call it
      // made, once in the answer — for the rest of the run and every replay after.
      // The record on disk keeps the content; only the view drops it.
      if (view.files?.out) delete view.files.out.content
      return recorded(view)
    },

    edit: async ({ path, old: oldStr, new: newStr, err, ...rest }) => {
      if (typeof oldStr !== 'string' || typeof newStr !== 'string') {
        return refuse('old and new are required and must be strings')
      }
      const bad = checkTargets({ path, old: oldStr, new: newStr, err, ...rest }, { target: 'path', accepts: ['path', 'old', 'new', 'err'] })
      if (bad) return bad
      const target = safe(path)
      if (!existsSync(target)) return refuse(`not found — ${path}`)
      const before = readFileSync(target, 'utf8')
      const count = before.split(oldStr).length - 1
      if (!oldStr) return refuse('old must not be empty — name the exact text to replace')
      if (count === 0) return refuse('old string not found in file')
      if (count > 1) return refuse(`old string found ${count} times — must be unique`)

      const after = before.replace(oldStr, () => newStr)
      const denied = runtimes(safe(path)) || unwritable(safe(path)) || unscheduled(safe(path), after)
      if (denied) return denied
      const targets = openTargets('edit', { out: path, err })
      if (targets.refusal) return targets.refusal
      const { call, outAbs, errAbs } = targets
      let exit = 1
      let errText = ''
      try {
        // A function replacement, so `$&` and `$1` in the new text stay literal —
        // the caller named bytes, not a pattern.
        writeFileSync(outAbs, after)
        exit = 0
      } catch (e) {
        errText = `${e.message}\n`
      }
      writeFileSync(errAbs, errText)
      if (!err) dropIfEmpty(errAbs)

      return recorded(contextView(trail.finish(call, {
        exit,
        replaced: exit === 0 ? 1 : 0,
        files: {
          out: await fileRecord(outAbs, { workspace: WS }),
          err: await fileRecord(errAbs, { workspace: WS })
        }
      })))
    },
    exec: async ({ command, in: inPath, out, err, timeout, idle, ...rest }, { signal: sig } = {}) => {
      const bad = checkTargets({ command, out, err, in: inPath, timeout, idle, ...rest }, { outRequired: false, accepts: ['command', 'out', 'in', 'err', 'timeout', 'idle'] })
      if (bad) return bad
      if (!existsSync(CONFINE_BIN)) {
        return refuse(`exec needs ${CONFINE_BIN}, which has not been built — run node-gyp rebuild`)
      }
      const timeoutMs = (timeout ?? EXEC_TIMEOUT_MS / 1000) * 1000
      if (!(timeoutMs > 0) || timeoutMs > EXEC_TIMEOUT_MAX_MS) {
        return refuse(`timeout must be between 1 and ${EXEC_TIMEOUT_MAX_MS / 1000} seconds`)
      }
      if (idle !== undefined && !(idle > 0)) return refuse('idle must be more than 0 seconds')
      const callIdleMs = Math.min(idle === undefined ? EXEC_IDLE_MS : idle * 1000, timeoutMs)
      return runCommand({ tool: 'exec', command, inPath, out, err, confined: true, timeoutMs, idleMs: callIdleMs, sig })
    },
    wsexec: async ({ command, in: inPath, out, err, timeout, idle, ...rest }, { signal: sig } = {}) => {
      const bad = checkTargets({ command, out, err, in: inPath, timeout, idle, ...rest }, { outRequired: false, accepts: ['command', 'out', 'in', 'err', 'timeout', 'idle'] })
      if (bad) return bad
      const timeoutMs = (timeout ?? EXEC_TIMEOUT_MS / 1000) * 1000
      if (!(timeoutMs > 0) || timeoutMs > EXEC_TIMEOUT_MAX_MS) {
        return refuse(`timeout must be between 1 and ${EXEC_TIMEOUT_MAX_MS / 1000} seconds`)
      }
      if (idle !== undefined && !(idle > 0)) return refuse('idle must be more than 0 seconds')
      const callIdleMs = Math.min(idle === undefined ? EXEC_IDLE_MS : idle * 1000, timeoutMs)
      return runCommand({ tool: 'wsexec', command, inPath, out, err, confined: false, timeoutMs, idleMs: callIdleMs, sig })
    },

    // The one tool that ends the turn. Its result is the question itself, not a
    // call record: the loop returns a terminal tool's result as the turn's
    // output, and what reaches the user has to be the question.
    ask: async ({ question, ...rest }) => {
      if (typeof question !== 'string' || !question.trim()) {
        return refuse('question is required and must be a non-empty string')
      }
      const bad = checkTargets({ question, ...rest }, { outRequired: false, accepts: ['question'] })
      if (bad) return bad
      trail.finish(trail.begin('ask'), { question })
      return question.trim()
    },

    // Ends the turn with nothing to say. Its result is the reason, which the loop keeps
    // for the record and never hands anyone as an answer.
    quiet: async ({ because, ...rest }) => {
      if (typeof because !== 'string' || !because.trim()) {
        return refuse('because is required — one line for the record saying what you checked and why there is nothing to say')
      }
      const bad = checkTargets({ because, ...rest }, { outRequired: false, accepts: ['because'] })
      if (bad) return bad
      const person = unanswered()
      if (person) {
        const words = (person.text ?? person.bodyHead).replace(/\s+/g, ' ').trim()
        const quoted = words.length > 120 ? `${words.slice(0, 120)}…` : words
        return refuse(`someone wrote to you in this turn ("${quoted}") and is waiting for an answer — answer them, even briefly; quiet is only for a turn no person asked anything in`)
      }
      trail.finish(trail.begin('quiet'), { because })
      return because.trim()
    }
  }

  const defs = [
    {
      name: 'read',
      description: 'Read a file from the workspace. The file\'s text comes back in this conversation, as the content of the call record — the one tool whose result carries a file\'s text rather than leaving it in a file. For a file too large to return whole, slice it with offset and length: by line (offset is 1-based, the default) or by byte (offset is 0-based, unit: bytes). Use encoding for a file that is not UTF-8. A PNG, JPEG, WebP or GIF comes back as the picture itself, whole, so you can look at anything you download, are sent, or make.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'number', description: 'Where to start: line number, 1-based (default 1); or byte offset, 0-based, when unit is bytes' },
          length: { type: 'number', description: 'How many lines or bytes to return (default: to end of file)' },
          encoding: { type: 'string', description: 'Source encoding, e.g. latin1 or utf-16le (default utf-8)' },
          unit: { type: 'string', description: 'lines (default) or bytes — what offset and length count in' },
          numbered: { type: 'boolean', description: 'Start each line of content with its line number and →, counted from offset. For when you will point at, cite or count lines; the numbers are not part of the file.' }
        },
        required: ['path']
      }
    },
    {
      name: 'write',
      description: 'Write a file into the workspace. The content you pass becomes the file at `path`. Returns the call record: exit code, and the file size, hash and content when it is short.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Exact bytes the file should contain' },
          path: { type: 'string', description: 'Workspace path of the file to write, under data/' },
          err: { type: 'string', description: 'Workspace path to receive the failure message, under data/ (optional)' }
        },
        required: ['content', 'path']
      }
    },
    {
      name: 'edit',
      description: 'Replace a unique string in a workspace file, in place. Fails when `old` is absent or appears more than once, so a change can never land somewhere you did not intend.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace file to edit, in place' },
          old: { type: 'string', description: 'Exact string to find (must appear exactly once)' },
          new: { type: 'string', description: 'Replacement string' },
          err: { type: 'string', description: 'Workspace path to receive the failure message, under data/ (optional)' }
        },
        required: ['path', 'old', 'new']
      }
    },
    {
      name: 'exec',
      description: 'Run a shell command that cannot write to the workspace, but for this turn\'s tmp/. It can read anything there, run any installed program, and reach the network: use it to look around — find, grep, wc, git log, ls — and to fetch with curl. stdout goes to the file you name in `out`, or to an automatic one if you name none. Several exec calls run at once and in no particular order, so keep requests whose order matters, or that change something outside the workspace, in separate rounds. Returns the call record, with the output inline when it is short.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command line. Pipes, redirects, && and ; all work.' },
          out: { type: 'string', description: 'Workspace path to receive stdout, under data/ (optional; kept automatically when omitted)' },
          in: { type: 'string', description: 'Workspace file to redirect to stdin (optional)' },
          err: { type: 'string', description: 'Workspace path to receive stderr, under data/ (optional)' },
          timeout: { type: 'number', description: 'Seconds to allow, default 30.' },
          idle: { type: 'number', description: 'Seconds a command may go with no new output and no CPU time before it is killed, default 120; past the timeout, the timeout ends it first. Waiting on a model call or the network uses neither.' }
        },
        required: ['command']
      }
    },
    {
      name: 'wsexec',
      description: 'Run a shell command that may write to the workspace — compilers, generators, anything producing files. stdout goes to the file you name in `out`, or to an automatic one if you name none. Prefer exec when the command only reads, because several exec calls run at once while wsexec calls run one after another.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command line. Pipes, redirects, && and ; all work.' },
          out: { type: 'string', description: 'Workspace path to receive stdout, under data/ (optional; kept automatically when omitted)' },
          in: { type: 'string', description: 'Workspace file to redirect to stdin (optional)' },
          err: { type: 'string', description: 'Workspace path to receive stderr, under data/ (optional)' },
          timeout: { type: 'number', description: 'Seconds to allow, default 30.' },
          idle: { type: 'number', description: 'Seconds a command may go with no new output and no CPU time before it is killed, default 120; past the timeout, the timeout ends it first. Waiting on a model call or the network uses neither.' }
        },
        required: ['command']
      }
    },
    {
      name: 'ask',
      description: 'Put a question to the user and end the turn. Use it when you cannot go on without something only they can tell you: a choice between real alternatives, a fact that is nowhere in the workspace, permission for something you cannot undo. Never use it for anything you could settle by reading a file or running a command — look first, ask only about what looking cannot answer. It ends the turn: no tool call after it runs, and their reply opens the next turn, so put everything you need into one question.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Shown to the user verbatim. They see none of your reasoning, so make it stand alone: name the alternatives and say what each one would mean.' }
        },
        required: ['question']
      }
    },
    {
      name: 'quiet',
      description: 'End the turn with nothing to say. Use it when the work is done and there is nothing worth telling anyone — a scheduled check that found no change, a watch with nothing new. Nobody is sent anything; the turn is recorded as quiet, with your reason. Never use it in place of an answer someone asked for, and never when something went wrong: a failure is always worth saying. It ends the turn: no tool call after it runs.',
      parameters: {
        type: 'object',
        properties: {
          because: { type: 'string', description: 'One line for the record, never shown as an answer: what you checked, and why there is nothing to say.' }
        },
        required: ['because']
      }
    }
  ]

  return { fns, defs }
}
