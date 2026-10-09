#!/usr/bin/env node
import { loadEnvironment } from '../src/index.js'
import { recordStarted } from '../src/library/service-record.js'
import { hooksPath, loadHooks } from '../webhook/hooks.js'
import { createWebhookServer } from '../webhook/server.js'

const REFUSED = 2
const DEFAULT_LISTEN = '127.0.0.1:8742'

const log = (line) => console.error(`${new Date().toISOString()} ${line}`)

const refuse = (err, hint) => {
  console.error(`spore-webhook: ${err.message}`)
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

const listen = process.env.SPORE_WEBHOOK_LISTEN || DEFAULT_LISTEN
const address = /^(.+):(\d+)$/.exec(listen)
if (!address) refuse(new Error(`SPORE_WEBHOOK_LISTEN is ${listen}`), `it is <host>:<port>, ${DEFAULT_LISTEN} when unset`)
const [, host, port] = address

let hooks
try {
  hooks = loadHooks(hooksPath(), process.env)
} catch (err) {
  refuse(err, err.type === 'WEBHOOK_NO_HOOKS'
    ? `echo '{"<hook>": {"spore": "<spore>", "verify": {"token": "\${HOOK_TOKEN}"}}}' > ${hooksPath()}`
    : null)
}

const urls = [...hooks.values()].map(hook => `  ${hook.name} → ${hook.spores.join(', ')} · http://${listen}/hook/${hook.name}${hook.check.method === 'path' ? '/<token>' : ''} · ${hook.check.method}`)

if (process.argv.includes('--check')) {
  console.log([`spore-webhook · ${listen} · ${hooksPath()} · ${hooks.size} hook(s)`, ...urls].join('\n'))
  process.exit(0)
}

const server = createWebhookServer({ env: launched, log })
server.on('error', err => refuse(err, err.code === 'EADDRINUSE' ? `something already listens on ${listen} — set SPORE_WEBHOOK_LISTEN in environment` : null))
server.listen(Number(port), host, () => {
  recordStarted('webhook')
  log(`spore-webhook · ${listen} · ${hooksPath()} · ${hooks.size} hook(s)`)
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => {
    log('stopped')
    process.exit(0)
  }))
}
