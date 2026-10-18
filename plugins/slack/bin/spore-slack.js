#!/usr/bin/env node
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SporeError } from '@rhizogrip/spore'
import { readBot, runService } from '@rhizogrip/spore/relay'

import { SLACK, createAdapter } from '../src/adapter.js'
import { createSlack } from '../src/api.js'
import { connect } from '../src/socket.js'

await runService({
  spec: SLACK,
  program: 'spore-slack',
  root: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  open: async ({ file, credentials }) => {
    const { team } = readBot(SLACK, file)
    const slack = createSlack({ token: credentials.token, app: credentials.app })
    const me = await slack.whoami()
    if (me.team_id !== team) {
      throw new SporeError(`the bot token is for workspace ${me.team_id}, and ${file} names ${team}`, { type: 'SLACK_BOT_INVALID', detail: `team is the workspace the bot serves: "team": "${me.team_id}" for this token (${me.team})` })
    }
    await slack.connection()
    const trace = () => readBot(SLACK, file).trace === true
    const receive = ({ onEnvelope, signal, log, sleep }) => connect({
      open: slack.connection,
      signal,
      log,
      sleep,
      onEnvelope: (envelope) => {
        if (trace()) log(`envelope ${envelope.type}: ${JSON.stringify(envelope.payload)}`)
        return onEnvelope(envelope)
      }
    })
    return { adapter: createAdapter({ slack, receive, team, me: me.user_id }), who: `@${me.user} in ${me.team}` }
  }
})
