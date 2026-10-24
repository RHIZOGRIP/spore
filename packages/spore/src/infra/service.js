/**
 * What every service process of the host does around its own work: a timestamped log on stderr,
 * a refusal as exit 2 with the line to fix, since systemd does not restart after it, and
 * `environment` loaded, with the environment it was launched with kept for the turns it starts.
 */

import { loadEnvironment } from '../library/config.js'

const REFUSED = 2

export function serviceProcess (program) {
  const log = (line) => console.error(`${new Date().toISOString()} ${line}`)
  const refuse = (err, hint) => {
    console.error(`${program}: ${err.message}`)
    if (err.detail) console.error(`  ${err.detail}`)
    if (hint) console.error(`  ${hint}`)
    process.exit(REFUSED)
  }
  const launched = { ...process.env }
  try {
    loadEnvironment()
  } catch (err) {
    refuse(err)
  }
  return { log, refuse, launched }
}

/** On SIGTERM or SIGINT, `stop()`, then `stopped` logged and exit 0. */
export function stopOn (log, stop) {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
      await stop()
      log('stopped')
      process.exit(0)
    })
  }
}
