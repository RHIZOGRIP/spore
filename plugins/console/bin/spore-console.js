#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readBot, routesOf, runService, statePath } from '@rhizogrip/spore/relay'

import { CONSOLE, createAdapter, listenOf } from '../src/adapter.js'
import { openEvents } from '../src/events.js'
import { serve } from '../src/server.js'

await runService({
  spec: CONSOLE,
  program: 'spore-console',
  root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  open: async ({ bot, file, credentials }) => {
    const { host, port, shown } = listenOf(readBot(CONSOLE, file), file)
    const events = openEvents(join(dirname(statePath(CONSOLE.kind, bot)), 'events.sqlite'))
    const receive = (handlers) => serve({ host, port, token: credentials.token, file, events, people: () => routesOf(CONSOLE, file), ...handlers })
    return { adapter: createAdapter({ name: bot, events, receive }), who: shown }
  }
})
