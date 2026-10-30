#!/usr/bin/env node
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readBot, runService } from '@rhizogrip/spore/relay'

import { createGraph } from '../src/api.js'
import { WHATSAPP, createAdapter, listenOf } from '../src/adapter.js'
import { serve } from '../src/server.js'

await runService({
  spec: WHATSAPP,
  program: 'spore-whatsapp',
  root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  open: async ({ file, credentials }) => {
    const { number, ...raw } = readBot(WHATSAPP, file)
    const { host, port, shown } = listenOf(raw, file)
    const graph = createGraph({ token: credentials.token, number })
    const me = await graph.me()
    const receive = ({ onDelivery, signal, log }) => serve({ host, port, secret: credentials.secret, verify: credentials.verify, onDelivery, signal, log })
    return { adapter: createAdapter({ graph, receive, number }), who: `${me.verified_name} (${me.display_phone_number}) on ${shown}` }
  }
})
