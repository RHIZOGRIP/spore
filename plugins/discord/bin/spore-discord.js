#!/usr/bin/env node
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runService } from '@rhizogrip/spore/relay'

import { createDiscord } from '../src/api.js'
import { DISCORD, createAdapter } from '../src/adapter.js'

await runService({
  spec: DISCORD,
  program: 'spore-discord',
  root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  open: async ({ file, credentials }) => {
    const discord = createDiscord(credentials.token)
    const me = await discord.me()
    return { adapter: createAdapter({ discord, me, botFile: file }), who: me.username }
  }
})
