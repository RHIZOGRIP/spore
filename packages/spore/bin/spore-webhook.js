#!/usr/bin/env node
import { recordStarted } from '../src/library/service-record.js'
import { hooksPath, loadHooks } from '../webhook/hooks.js'
import { createWebhookServer } from '../webhook/server.js'
import { listenOf } from '../src/infra/http.js'
import { serviceProcess, stopOn } from '../src/infra/service.js'

const { log, refuse, launched } = serviceProcess('spore-webhook')

let address
try {
  address = listenOf(process.env.SPORE_WEBHOOK_LISTEN || undefined, { port: 8742, refused: (problem, detail) => Object.assign(new Error(`SPORE_WEBHOOK_LISTEN ${problem}`), { detail }) })
} catch (err) {
  refuse(err)
}

let hooks
try {
  hooks = loadHooks(hooksPath(), process.env)
} catch (err) {
  refuse(err, err.type === 'WEBHOOK_NO_HOOKS'
    ? `echo '{"<hook>": {"spore": "<spore>", "verify": {"token": "\${HOOK_TOKEN}"}}}' > ${hooksPath()}`
    : null)
}

const urls = [...hooks.values()].map(hook => `  ${hook.name} → ${hook.spores.join(', ')} · http://${address.text}/hook/${hook.name}${hook.check.method === 'path' ? '/<token>' : ''} · ${hook.check.method}`)

if (process.argv.includes('--check')) {
  console.log([`spore-webhook · ${address.shown} · ${hooksPath()} · ${hooks.size} hook(s)`, ...urls].join('\n'))
  process.exit(0)
}

const server = createWebhookServer({ env: launched, log })
server.on('error', err => refuse(err, err.code === 'EADDRINUSE' ? `something already listens on ${address.text} — set SPORE_WEBHOOK_LISTEN in environment` : null))
server.listen(address.port, address.host, () => {
  recordStarted('webhook')
  log(`spore-webhook · ${address.shown} · ${hooksPath()} · ${hooks.size} hook(s)`)
})

stopOn(log, () => new Promise(resolve => server.close(resolve)))
