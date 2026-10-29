#!/usr/bin/env node
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import { CAIRN_NAME, serve, tokenVariable } from '../src/daemon.js'

const USAGE = 'usage: cairn serve <name>.json --db <file> --socket <path>'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { db: { type: 'string' }, socket: { type: 'string' } }
})
const [verb, instanceFile] = positionals
if (verb !== 'serve' || !instanceFile || !values.db || !values.socket) {
  console.error(USAGE)
  process.exit(2)
}
const name = basename(instanceFile, '.json')
if (!CAIRN_NAME.test(name)) {
  console.error(`cairn: ${name} is not a cairn name (lowercase letters, digits and -)`)
  process.exit(2)
}
const variable = tokenVariable(name)
const token = process.env[variable]
if (!token) {
  console.error(`cairn ${name}: ${variable} is not set`)
  process.exit(2)
}

const daemon = await serve({ name, instanceFile, file: values.db, socket: values.socket, token })
console.log(`cairn ${name}: serving ${values.socket}`)
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => daemon.close().then(() => process.exit(0), (err) => {
    console.error(`cairn ${name}: ${err.message}`)
    process.exit(1)
  }))
}
