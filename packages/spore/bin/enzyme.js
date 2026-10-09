#!/usr/bin/env node
/**
 * enzyme — call an enzyme the caller has no path to.
 *
 *   enzyme <name> [args...]     socket from $SPORE_ENZYMES
 *
 * Self-contained on purpose: it is copied into a sub-agent's workspace, where
 * nothing else of spore is reachable.
 */

import http from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Beside this file, because both are staged into the workspace together and the
// agent may run this from anywhere. Never from the environment: `wsexec` hands the
// environment to every command, so a key there ends up in a call record.
const keyPath = resolve(dirname(fileURLToPath(import.meta.url)), 'model.key')
let key = null
try { key = readFileSync(keyPath, 'utf8').trim() } catch {}

const socketPath = process.env.SPORE_ENZYMES
const [name, ...args] = process.argv.slice(2)

if (!socketPath) {
  console.error('enzyme: SPORE_ENZYMES is not set — no enzymes are available here')
  process.exit(2)
}
if (!name) {
  console.error('enzyme: usage: enzyme <name> [args...]')
  process.exit(2)
}

// The exit code is set, never exited on: what the enzyme wrote may still be queued for a
// pipe whose reader is slow, and leaving now would drop it while reporting success. Closing
// stdin and the connection leaves nothing to keep the process alive but that output, so it
// ends once the output is delivered.
let answered = false
const finish = (code) => {
  if (answered) return
  answered = true
  process.exitCode = code
  process.stdin.unpipe(req)
  process.stdin.destroy()
  req.destroy()
}

// stdin goes only once the broker has accepted the call: a refusal then arrives on a
// connection nothing was still being written to, and its exit code is not lost to a
// failed write.
let sending = false
const send = () => {
  if (sending) return
  sending = true
  process.stdin.pipe(req)
}

const query = new URLSearchParams([['enzyme', name], ...args.map(arg => ['arg', arg])])
const req = http.request({
  socketPath,
  method: 'POST',
  path: `/run?${query}`,
  headers: {
    ...(key ? { 'x-spore-key': key } : {}),
    'content-type': 'application/octet-stream',
    expect: '100-continue'
  }
}, (res) => {
  if (res.statusCode !== 200) {
    const chunks = []
    res.on('data', chunk => chunks.push(chunk))
    res.on('end', () => {
      let refusal = {}
      try { refusal = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
      const message = refusal.message || `the enzyme broker answered ${res.statusCode}`
      console.error(`enzyme: ${message}${refusal.detail ? ` — ${refusal.detail}` : ''}`)
      finish(127)
    })
    return
  }
  send()

  // A stream that will not take more holds the reading back, so a slow reader slows the
  // enzyme rather than growing a queue here.
  const deliver = (stream, data) => {
    if (!stream.write(Buffer.from(data, 'base64'))) {
      res.pause()
      stream.once('drain', () => res.resume())
    }
  }

  const handle = (line) => {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      console.error('enzyme: the enzyme broker sent something that is not an event')
      return finish(2)
    }
    if (event.type === 'stdout') deliver(process.stdout, event.data)
    else if (event.type === 'stderr') deliver(process.stderr, event.data)
    else if (event.type === 'exit') finish(event.code)
  }

  let pending = ''
  res.setEncoding('utf8')
  res.on('data', (chunk) => {
    pending += chunk
    let end
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      handle(line)
      if (answered) break
    }
  })
  res.on('close', () => {
    if (answered) return
    console.error('enzyme: the enzyme broker ended the call without an exit code')
    finish(2)
  })
})

req.on('continue', send)
req.on('error', (e) => {
  // Once an answer is in, a write still in flight failing says nothing the caller needs,
  // and reporting it would overwrite the exit code the broker just sent.
  if (answered || e.code === 'EPIPE' || e.code === 'ERR_STREAM_WRITE_AFTER_END') return
  console.error(`enzyme: cannot reach the enzyme broker: ${e.code || e.message}`)
  finish(2)
})
req.flushHeaders()
