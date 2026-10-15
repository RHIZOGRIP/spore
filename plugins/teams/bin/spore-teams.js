#!/usr/bin/env node
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readBot, runService } from '@rhizogrip/spore/relay'

import { createConnector } from '../src/api.js'
import { createToken, createVerifier } from '../src/auth.js'
import { TEAMS, createAdapter, listenOf } from '../src/adapter.js'
import { serve } from '../src/server.js'

await runService({
  spec: TEAMS,
  program: 'spore-teams',
  root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  open: async ({ file, credentials }) => {
    const { app, tenant, ...raw } = readBot(TEAMS, file)
    const { host, port } = listenOf(raw, file)
    const token = createToken({ app, tenant, secret: credentials.secret })
    await token()
    const verify = createVerifier({ app })
    const receive = ({ onActivity, signal, log }) => serve({ host, port, verify, onActivity, signal, log })
    return { adapter: createAdapter({ connector: createConnector({ token }), receive, app, tenant }), who: `app ${app} on ${host}:${port}` }
  }
})
