#!/usr/bin/env node
/**
 * Everything about the conformance suite that can be checked without calling a model:
 * the cases, the identities they generate, the precursors they name, and — the part
 * that matters most — the grader itself.
 *
 * A grader that is wrong makes the whole suite lie in the direction nobody checks, so
 * every expectation kind is exercised here against a workspace built to pass it and one
 * built to fail it.
 *
 *   node conformance/selfcheck.js
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseDefinition } from '../src/delegation/definition.js'
import { TOOL_NAMES } from '../src/core/tool-names.js'
import { writeTranscriptEntries, writeTurnRecords } from '../src/core/spore-dir.js'
import { writeCall } from '../src/core/call-record.js'
import { CASES, TIERS } from './cases.js'
import { stage } from './stage.js'
import { grade } from './check.js'

const HERE = dirname(fileURLToPath(import.meta.url))
let failures = 0
const check = (name, ok, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

console.log('the cases')
check('every id is unique', new Set(CASES.map(c => c.id)).size === CASES.length)
check('every tier is known', CASES.every(c => TIERS.includes(c.tier)))
check('every case says what it is for', CASES.every(c => c.feature && c.feature.length > 4))
check('every case grants at least one tool', CASES.every(c => c.grants?.length))
check('every case expects something', CASES.every(c => Object.keys(c.expect || {}).length))
check('every prompt names what it wants', CASES.every(c => c.prompt.length > 30))
// A case granting a tool it never needs is a case that can pass by accident.
check('no case grants spawn tools it does not use', CASES.every(c =>
  c.precursor || !c.parts || c.grants.includes('wsexec')))
// An expectation the grader does not know is an expectation that never runs, and the
// case goes green on whatever is left. `refusals` was a key here until the boundary
// cases learned to name their target, and a leftover would have silently stopped
// checking anything.
const EXPECTATIONS = ['stopReason', 'concluded', 'answer', 'files', 'calls', 'absent', 'cells']
check('every expectation is one the grader reads', CASES.every(c =>
  Object.keys(c.expect).every(k => EXPECTATIONS.includes(k))),
CASES.flatMap(c => Object.keys(c.expect).filter(k => !EXPECTATIONS.includes(k)).map(k => `${c.id}.${k}`)).join(', '))

console.log('\nthe precursors they name')
for (const name of [...new Set(CASES.map(c => c.precursor).filter(Boolean))]) {
  const parsed = parseDefinition(readCmk(name), { knownTools: TOOL_NAMES, cell: true })
  check(`${name}.cmk parses as a precursor`, !parsed.error, parsed.error || '')
}

console.log('\nthe identity each case generates')
const root = mkdtempSync(join(tmpdir(), 'conformance-self-'))
try {
  for (const item of CASES) {
    const { ws, cmk } = stage(root, item, 'selfcheck/no-model')
    const parsed = parseDefinition(readFileSync(cmk, 'utf8'), { knownTools: TOOL_NAMES })
    if (parsed.error) {
      check(`${item.id} identity parses`, false, parsed.error)
      continue
    }
    const granted = new Set(parsed.tools)
    check(`${item.id} grants exactly what it asked for`,
      item.grants.every(t => granted.has(t)) && granted.size === item.grants.length,
      `got ${[...granted].join(', ')}`)
    check(`${item.id} staged its fixtures`, Object.keys(item.files || {}).every(p => existsSync(resolve(ws, p))))
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('\nthe grader, against workspaces built to pass and to fail')
const bench = mkdtempSync(join(tmpdir(), 'conformance-grade-'))
try {
  const AT = '2026-09-27T00:00:00.000Z'
  const makeWithMessages = (turn, messages) => {
    const ws = mkdtempSync(join(bench, 'msg-'))
    mkdirSync(resolve(ws, 'data'), { recursive: true })
    writeTurnRecords(ws, [{ startedAt: AT, ...turn }])
    writeTranscriptEntries(ws, messages.map(message => ({ at: AT, kind: 'message', role: message.role, message })))
    return ws
  }

  const make = ({ turn, output = '', files = {}, calls = [], cell = null }) => {
    const ws = mkdtempSync(join(bench, 'ws-'))
    mkdirSync(resolve(ws, 'data'), { recursive: true })
    writeTurnRecords(ws, [{ startedAt: AT, ...turn }])
    writeTranscriptEntries(ws, [{ at: AT, kind: 'message', role: 'assistant', message: { role: 'assistant', content: output } }])
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(resolve(ws, path)), { recursive: true })
      writeFileSync(resolve(ws, path), body)
    }
    calls.forEach((record, i) => writeCall(ws, 'r', String(i + 1).padStart(4, '0'), { startedAt: AT, ...record }))
    if (cell) {
      const dir = resolve(ws, 'data', 'one')
      mkdirSync(dir, { recursive: true })
      writeFileSync(resolve(dir, 'spawn.json'), JSON.stringify(cell) + '\n')
    }
    return ws
  }
  const answered = { stopReason: 'answer', concluded: true }

  check('a passing case passes',
    grade(make({ turn: answered, output: 'ready' }), { expect: { stopReason: 'answer', answer: /ready/ } }).length === 0)
  check('a wrong stop reason fails',
    grade(make({ turn: { stopReason: 'hard:rounds' } }), { expect: { stopReason: 'answer' } }).length === 1)
  check('a missing file fails',
    grade(make({ turn: answered }), { expect: { files: { 'data/out.txt': 'x' } } })[0]?.includes('was not written'))
  check('wrong file contents fail',
    grade(make({ turn: answered, files: { 'data/out.txt': 'nope' } }), { expect: { files: { 'data/out.txt': 'x' } } }).length === 1)
  check('exact file contents pass',
    grade(make({ turn: answered, files: { 'data/out.txt': '12\n13\n' } }), { expect: { files: { 'data/out.txt': '12\n13\n' } } }).length === 0)
  // Boundary cases. Every one of these workspaces holds a real refusal recorded by the
  // runtime; what the case has to establish is that it was the refusal it asked for.
  const rootWrite = { tool: 'write', target: /^(\.\/)?note\.txt$/, refused: true }
  const refusedRootWrite = { tool: 'write', args: { path: 'note.txt', content: 'x' }, refused: true, exit: 1 }
  const refusedMissingRead = { tool: 'read', args: { path: 'data/missing.txt' }, refused: true, exit: 1 }

  check('a case wanting a refusal fails without one',
    grade(make({ turn: answered }), { expect: { calls: [rootWrite] } }).length === 1)
  check('the refusal the case named satisfies it',
    grade(make({ turn: answered, calls: [refusedRootWrite] }), { expect: { calls: [rootWrite] } }).length === 0)
  check('a refusal of something else does not',
    grade(make({ turn: answered, calls: [refusedMissingRead] }), { expect: { calls: [rootWrite] } }).length === 1)
  check('the forbidden file existing fails the case',
    grade(make({ turn: answered, calls: [refusedRootWrite], files: { 'note.txt': 'x' } }),
      { expect: { calls: [rootWrite], absent: ['note.txt'] } }).length === 1)

  // Core cases, where the trap is the opposite one: the right answer reached the right
  // way and reached another way look identical on disk.
  const ranBoth = { tool: 'exec', target: /exit\s+7/, exit: 7 }
  check('an exit code has to come from a command that returned it',
    grade(make({ turn: answered, output: '7' }), { expect: { answer: /7/, calls: [ranBoth] } }).length === 1)
  check('the command that returned it satisfies the case',
    grade(make({ turn: answered, output: '7', calls: [{ tool: 'exec', command: 'exit 7', exit: 7 }] }),
      { expect: { answer: /7/, calls: [ranBoth] } }).length === 0)
  check('a command that returned something else does not',
    grade(make({ turn: answered, output: '7', calls: [{ tool: 'exec', command: 'exit 7', exit: 0 }] }),
      { expect: { answer: /7/, calls: [ranBoth] } }).length === 1)

  const ranged = { tool: 'read', target: /numbers\.txt/, eof: false }
  const wholeFile = { tool: 'read', path: 'data/numbers.txt', offset: 0, lines: 40, eof: true }
  check('reading the whole file and keeping three lines is not a range read',
    grade(make({ turn: answered, calls: [wholeFile] }), { expect: { calls: [ranged] } }).length === 1)
  check('a read that stopped short of the end is',
    grade(make({ turn: answered, calls: [{ ...wholeFile, offset: 11, lines: 3, eof: false }] }),
      { expect: { calls: [ranged] } }).length === 0)

  const ranProgram = { tool: 'wsexec', target: /total\.mjs/, exit: 0 }
  check('a program on disk that was never run does not prove the library',
    grade(make({ turn: answered, files: { 'data/total.mjs': "import { parse } from 'csv-parse/sync'" } }),
      { expect: { files: { 'data/total.mjs': /csv-parse/ }, calls: [ranProgram] } }).length === 1)

  const blocked = { tool: 'exec', target: /made-by-exec/, refused: false, failed: true }
  check('an exec that was blocked counts',
    grade(make({ turn: answered, calls: [{ tool: 'exec', command: 'echo x > data/made-by-exec.txt', exit: 2 }] }),
      { expect: { calls: [blocked] } }).length === 0)
  check('reporting blocked without running anything does not',
    grade(make({ turn: answered, files: { 'data/out.txt': 'blocked' } }),
      { expect: { files: { 'data/out.txt': /blocked/ }, calls: [blocked] } }).length === 1)
  check('an exec that succeeded does not',
    grade(make({ turn: answered, calls: [{ tool: 'exec', command: 'echo x > data/made-by-exec.txt', exit: 0 }] }),
      { expect: { calls: [blocked] } }).length === 1)
  check('a cell that answered counts',
    grade(make({ turn: { ...answered, ownMicros: 10000, treeMicros: 40000 }, cell: { answer: 'data/out.json' } }), { expect: { cells: 1 } }).length === 0)
  // A parent can write `spawn.json` itself — it lives under `data/`. Only the turn
  // record, which only the runner writes, says a cell really spent.
  check('frames a parent could have written are not proof on their own',
    grade(make({ turn: { ...answered, ownMicros: 10000, treeMicros: 10000 }, cell: { answer: 'data/out.json' } }), { expect: { cells: 1 } })
      .some(p => p.includes('no child spend')))
  check('a cell that did not answer does not',
    grade(make({ turn: { ...answered, ownMicros: 10000, treeMicros: 40000 }, cell: { answer: null } }), { expect: { cells: 1 } }).length === 1)
  // Counterexamples: each keeps the superficial success signal and breaks the intent.
  // Every one of these passed before, and the suite reported green alongside them.
  check('a failed turn does not pass on its artifact alone',
    grade(make({ turn: { stopReason: 'error', error: 'MODEL_REFUSED', concluded: false }, files: { 'data/out.txt': 'x' } }),
      { expect: { files: { 'data/out.txt': 'x' } } }).some(p => p.includes('stopReason')))

  check('the case prompt is not accepted as the answer',
    grade(makeWithMessages({ stopReason: 'answer', concluded: false }, [{ role: 'user', content: 'Reply with exactly the word ready.' }]),
      { expect: { answer: /ready/i } }).some(p => p.includes('answer did not match')))

  check('a terminal question counts as the answer only when the turn ended with it',
    grade(makeWithMessages({ stopReason: 'question', concluded: true }, [
      { role: 'user', content: 'ask them' }, { role: 'assistant', content: '' }, { role: 'tool', content: 'Which month?' }
    ]), { expect: { stopReason: 'question', answer: /month/i } }).length === 0)

  check('a different soft bound is not the one asked for',
    grade(make({ turn: { stopReason: 'soft:cost', concluded: true } }), { expect: { stopReason: 'soft:rounds', concluded: true } }).length === 1)

  check('a workspace that never ran says so',
    grade(mkdtempSync(join(bench, 'empty-')), { expect: { stopReason: 'answer' } })[0]?.includes('never ran'))
} finally {
  rmSync(bench, { recursive: true, force: true })
}

console.log(`\n${failures ? `${failures} failed` : 'all checks passed'} — no model, no spend`)
process.exit(failures ? 1 : 0)

function readCmk (name) {
  return readFileSync(resolve(HERE, 'precursors', `${name}.cmk`), 'utf8')
}
