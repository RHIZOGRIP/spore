#!/usr/bin/env node
import { createRequire } from 'node:module'

import { run } from '../src/run.js'

const { call, list } = createRequire(import.meta.url)('sluicify-native')

process.exitCode = run(process.argv.slice(2), {
  socket: process.env.SPORE_SLUICE_SOCKET,
  call,
  list,
  print: (text) => process.stdout.write(text),
  say: (line) => process.stderr.write(`sluice: ${line}\n`)
})
