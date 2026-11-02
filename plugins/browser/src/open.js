import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { profileArgs } from './chrome.js'

/**
 * The pid of the browser service, read from the record it wrote when it started, while that
 * process is still running it — a record outlives its process, and a pid is reused.
 */
export function runningService (record) {
  let pid
  try {
    pid = JSON.parse(readFileSync(record, 'utf8')).pid
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  let argv
  try {
    argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  return argv.some(arg => basename(arg) === 'spore-browser.js') ? pid : null
}

/**
 * A window on a persistent spore's profile, for the operator to log it in: the profile, cache
 * and home the service gives that spore's headless browser, outside `confine`, which would hide
 * the display. Settles when the window closes.
 */
export function openWindow ({ executable, root, url }) {
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const window = spawn(executable, [...profileArgs({ profile: join(root, 'profile'), cache: join(root, 'cache') }), ...(url ? [url] : [])], {
    stdio: 'ignore',
    env: { ...process.env, HOME: home }
  })
  return new Promise((resolve, reject) => {
    window.on('error', reject)
    window.on('exit', (code, signal) => resolve({ code, signal }))
  })
}
