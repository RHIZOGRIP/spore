#!/usr/bin/env node
import { loadEnvironment, tick, tickReport } from '../src/index.js'

try {
  loadEnvironment()
  const { lines, exit } = tickReport(tick())
  for (const line of lines) console.log(line)
  process.exit(exit)
} catch (err) {
  console.error(`spore-tick: ${err.detail ? `${err.message} — ${err.detail}` : err.message}`)
  process.exit(2)
}
