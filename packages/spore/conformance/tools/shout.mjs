#!/usr/bin/env node
/**
 * Upper-cases its input. Takes it on stdin or as arguments, because a model reaches for
 * `tool arg` first and a tool that only accepts one of the two costs a round teaching
 * the other — measured on a benchmark run, where several cells spent their whole budget
 * discovering the calling convention.
 */
const fromArgs = process.argv.slice(2).join(' ')
const text = fromArgs || await new Promise(resolve => {
  let buf = ''
  process.stdin.on('data', chunk => { buf += chunk })
  process.stdin.on('end', () => resolve(buf))
})
process.stdout.write(text.trim().toUpperCase() + '\n')
