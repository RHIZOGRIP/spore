/**
 * What a person is shown of a tool call — `{ title, category, detail }` — from a spore's own
 * `:::call` rows, then its plugins', then the runtime's. Contract: ARCHITECTURE.md, "Describing a
 * call". The rows, their checks and the matching are `rust/definition`, reached through the addon.
 */

import { native } from '../native.js'
import { SporeError } from '../observability/errors.js'

const COMMANDS = ['exec', 'wsexec']

const answered = (json, type) => {
  const answer = JSON.parse(json)
  if (answer.error) throw new SporeError(answer.error, { type })
  return answer
}

export function pluginCallRows (plugin, describe, programs) {
  const rows = describe.map((row, i) => ({ ...row, name: `${plugin}/${i + 1}`, tools: COMMANDS }))
  return answered(native.checkCallRows(JSON.stringify(rows), programs), 'PLUGIN_INVALID').rows
}

export function describeCall (name, args, rows = []) {
  return answered(native.describeCall(name, JSON.stringify(args ?? {}), JSON.stringify(rows)), 'CALL_ROWS_INVALID')
}
