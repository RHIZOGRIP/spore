#!/usr/bin/env node
import { errorText, loadEnvironment, tick, tickReport } from '../src/index.js'

try {
  loadEnvironment()
  const { lines, exit } = tickReport(tick())
  for (const line of lines) console.log(line)
  process.exit(exit)
} catch (err) {
  console.error(`spore-tick: ${errorText(err)}`)
  process.exit(2)
}
