#!/usr/bin/env node
/**
 * Mock spore — reads RunEnvelope on stdin, emits PROTOCOL §4 wire
 * frames to stdout, exits. No LLM, no real loop. Optionally executes
 * a `.mock-instruction` file in the workspace (writeFile) to exercise
 * file-side-effect tests.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// Read stdin via fd 0 — works even after the parent end()s the pipe.
const stdin = readFileSync(0, 'utf8').trim()
const envelope = stdin ? JSON.parse(stdin) : {}
const WS = envelope.workspace?.root || process.cwd()
const task = (envelope.input && typeof envelope.input === 'object')
  ? envelope.input.task || ''
  : (typeof envelope.input === 'string' ? envelope.input : '')

// Optional instruction-driven side effects (writeFile + override
// output / problems for negative-path tests).
const instructionFile = resolve(WS, '.mock-instruction')
let result
if (existsSync(instructionFile)) {
  const instruction = JSON.parse(readFileSync(instructionFile, 'utf8'))
  if (instruction.writeFile) {
    writeFileSync(resolve(WS, instruction.writeFile.path), instruction.writeFile.content)
  }
  result = {
    output: instruction.output || task,
    cost: 0.001,
    own: { cost: 0.001, tokens: { input: 100, output: 50, thinking: 0 }, rounds: 1 },
    children: { count: 0, cost: 0, tokens: { input: 0, output: 0, thinking: 0 }, results: [] },
    model: 'mock/test',
    rounds: 1,
    problems: instruction.problems || []
  }
} else {
  result = {
    output: `done: ${task}`,
    cost: 0.001,
    own: { cost: 0.001, tokens: { input: 100, output: 50, thinking: 0 }, rounds: 1 },
    children: { count: 0, cost: 0, tokens: { input: 0, output: 0, thinking: 0 }, results: [] },
    model: 'mock/test',
    rounds: 1,
    problems: []
  }
}

process.stdout.write(JSON.stringify({ type: 'run_done', result }) + '\n')
