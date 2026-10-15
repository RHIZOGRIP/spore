#!/usr/bin/env node
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runService } from '@rhizogrip/spore/relay'

import { createTelegram } from '../src/api.js'
import { TELEGRAM, createAdapter } from '../src/adapter.js'

await runService({
  spec: TELEGRAM,
  program: 'spore-telegram',
  root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  open: async ({ bot, credentials }) => {
    const telegram = createTelegram(credentials.token)
    const me = await telegram.me()
    return { adapter: createAdapter({ telegram, bot, me }), who: `@${me.username}` }
  }
})
