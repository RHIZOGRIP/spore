#!/usr/bin/env node
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import { verifyCairn } from '../src/cairn.js'
import { CAIRN_NAME, serve, tokenVariable } from '../src/daemon.js'

const USAGE = `usage: cairn serve <name>.json --db <file> --socket <path>
       cairn verify <cairn.sqlite> [--evidence] [--json]`

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: 'string' },
    socket: { type: 'string' },
    evidence: { type: 'boolean' },
    json: { type: 'boolean' }
  }
})
const [verb, target] = positionals
const usage = () => {
  console.error(USAGE)
  process.exit(2)
}

if (verb === 'verify') {
  if (!target || positionals.length > 2 || values.db || values.socket) usage()
  let result
  try {
    result = verifyCairn(target, { evidence: values.evidence })
  } catch (err) {
    console.error(`cairn verify ${target}: ${err.message}`)
    process.exit(2)
  }
  if (values.json) console.log(JSON.stringify(result))
  else console.log(`${result.name}: ${said(result)}`)
  process.exit(result.ok ? 0 : 1)
}

if (verb !== 'serve' || !target || !values.db || !values.socket || values.evidence || values.json) usage()
const name = basename(target, '.json')
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

const daemon = await serve({ name, instanceFile: target, file: values.db, socket: values.socket, token })
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => daemon.close().then(() => process.exit(0), (err) => {
    console.error(`cairn ${name}: ${err.message}`)
    process.exit(1)
  }))
}
console.log(`cairn ${name}: serving ${values.socket}`)

function said ({ head, checked, firstBreak, gap, evidence }) {
  if (firstBreak) return `broken at seq ${firstBreak.seq}: ${firstBreak.why} (${checked} checked before it)`
  if (gap) return `broken after seq ${gap.after}: the next entry is seq ${gap.next} (${checked} checked before it)`
  if (evidence?.broken) {
    const { seq, key, sha256, why } = evidence.broken
    return `evidence broken at seq ${seq}: its ${key} ${sha256} — ${why}`
  }
  if (!head) return 'ok, no entries'
  const files = evidence ? `, ${evidence.files} evidence ${evidence.files === 1 ? 'file' : 'files'}` : ''
  return `ok, ${checked} entries${files}, head seq ${head.seq} ${head.hash} at ${head.at}`
}
