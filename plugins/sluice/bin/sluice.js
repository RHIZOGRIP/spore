#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { run } from '../src/run.js'

const { call } = createRequire(import.meta.url)('sluicify-native')

const read = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

process.exitCode = run(process.argv.slice(2), {
  socket: process.env.SPORE_SLUICE_SOCKET,
  call,
  read,
  print: (text) => process.stdout.write(text),
  say: (line) => process.stderr.write(`sluice: ${line}\n`)
})
