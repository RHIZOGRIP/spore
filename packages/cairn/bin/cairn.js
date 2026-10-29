#!/usr/bin/env node
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import { serve } from '../src/daemon.js'

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
if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
  console.error(`cairn: ${name} is not a cairn name (lowercase letters, digits and -)`)
  process.exit(2)
}
const variable = `CAIRN_${name.toUpperCase().replaceAll('-', '_')}_TOKEN`
const token = process.env[variable]
if (!token) {
  console.error(`cairn ${name}: ${variable} is not set`)
  process.exit(2)
}

const daemon = await serve({ name, instanceFile, file: values.db, socket: values.socket, token })
console.log(`cairn ${name}: serving ${values.socket}`)
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => daemon.close().then(() => process.exit(0)))
}
