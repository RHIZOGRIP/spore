import { accessSync, constants } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'

const STOP_GRACE_MS = 10_000
const STDERR_KEPT = 16 * 1024
const VERSION_MS = 10_000

/**
 * The Chromium-based browser the operator named in the `chromium` setting — a command on `path`
 * or an absolute path — and the line its `--version` prints.
 */
export function findChromium (named, path = process.env.PATH) {
  let executable = named
  if (!isAbsolute(named)) {
    try {
      executable = execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', named], { encoding: 'utf8', env: { PATH: path } }).trim()
    } catch {
      throw new Error(`chromium is ${named}, which is not on the service's PATH (${path}) — name the browser by its absolute path, or put its directory on PATH in ~/.config/spore/environment`)
    }
  }
  try {
    accessSync(executable, constants.X_OK)
  } catch {
    throw new Error(`chromium is ${executable}, which is not an executable file`)
  }
  let version
  try {
    version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: VERSION_MS, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (err) {
    throw new Error(`${executable} --version failed — ${err.message.split('\n')[0]}`)
  }
  return { executable, version }
}

/**
 * One headless Chrome on `--remote-debugging-pipe`, so it has no debugging port: CDP goes over
 * fds 3 and 4, one NUL-terminated JSON message each way. `onExit` is told when it ends
 * without `stop()` having asked it to.
 */
export function startChrome ({ executable, profile, cache, home, tmp, onExit }) {
  const child = spawn(executable, [
    '--headless',
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    `--disk-cache-dir=${cache}`,
    '--password-store=basic',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  ], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmp }
  })

  let stderr = ''
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-STDERR_KEPT) })
  let stopping = false
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })))
  exited.then(ended => {
    for (const settle of waiting.values()) settle({ error: { code: -32000, message: 'the browser stopped' } })
    waiting.clear()
    if (!stopping) onExit({ ...ended, stderr })
  })
  for (const fd of [3, 4]) child.stdio[fd].on('error', () => {})

  const waiting = new Map()
  const listeners = new Set()
  let nextId = 1
  let buffered = ''
  child.stdio[4].on('data', chunk => {
    buffered += chunk
    let end
    while ((end = buffered.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffered.slice(0, end))
      buffered = buffered.slice(end + 1)
      if (message.id === undefined) {
        for (const listener of listeners) listener(message)
        continue
      }
      const settle = waiting.get(message.id)
      waiting.delete(message.id)
      if (settle) settle(message)
    }
  })

  function request ({ method, params = {}, sessionId }) {
    const id = nextId++
    const message = { id, method, params, ...(sessionId ? { sessionId } : {}) }
    return new Promise(resolve => {
      waiting.set(id, resolve)
      child.stdio[3].write(JSON.stringify(message) + '\0')
    })
  }

  async function stop () {
    stopping = true
    if (child.exitCode === null && child.signalCode === null) {
      request({ method: 'Browser.close' })
      const timer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS)
      await exited
      clearTimeout(timer)
    }
    return exited
  }

  return { request, onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener) }, stop, pid: child.pid }
}
