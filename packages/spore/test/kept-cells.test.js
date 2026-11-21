/**
 * A cell kept with `spawn --keep` and asked again with `spawn --resume`, from inside real
 * turns: the runner serves the cell socket, reads the precursor and writes the entry under
 * `cells/` (ARCHITECTURE §Kept cells). The session is scripted; the runner, the agent,
 * `spore-spawn` and the cell are real.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { takeSlot } from '../src/core/admission.js'
import { CONFIG_FILE } from '../src/library/config.js'
import { CELLS_DIR, enqueue, readLock, readTurns } from '../src/core/spore-dir.js'
import { stop } from '../src/core/state.js'
import { outsideRoot, outsideWorkspace } from './fixtures/outside-ws.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUNNER = resolve(HERE, '../native', process.arch, 'spore-runner')
const CHATGPT_HELPER = createRequire(import.meta.url).resolve('mohdel/chatgpt/bin')
const SUMMARIZE = resolve(HERE, 'fixtures/plugins/docs/precursors/summarize.cmk')

let root
let ws
let marks
let commands

const until = async (done, limitMs = 20000) => {
  const deadline = Date.now() + limitMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`waited too long — ${existsSync(resolve(ws, 'spore.err')) ? readFileSync(resolve(ws, 'spore.err'), 'utf8').slice(-1500) : 'no spore.err'}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

// Each turn of the root is two calls: the first runs the turn's command under wsexec, the second
// answers. A cell's call is told apart by the task its prompt file holds, which the command
// writes in two pieces so that the root's own conversation never holds it whole.
const session = () => `
import { createInterface } from 'node:readline'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
const MARKS = ${JSON.stringify(marks)}
const mark = (what) => appendFileSync(MARKS, JSON.stringify({ what }) + '\\n')
const rootCalls = () => existsSync(MARKS) ? readFileSync(MARKS, 'utf8').split('\\n').filter(line => line.includes('"root"')).length : 0
const write = (event) => process.stdout.write(JSON.stringify(event) + '\\n')
const now = () => String(process.hrtime.bigint())
createInterface({ input: process.stdin }).on('line', (line) => {
  const asked = JSON.parse(line)
  if (asked.op === 'ping') return write({ op: 'pong' })
  if (asked.op === 'info') return write({ type: 'info_done', result: { contextTokenLimit: 200000, turnTokenBase: 12000 } })
  if (asked.op) return
  const start = now()
  const done = (result) => write({ type: 'done', result: { inputTokens: 10, outputTokens: 5, thinkingTokens: 0, cost: 0.01, timestamps: { start, first: start, end: now() }, ...result } })
  if (line.includes('CELL-TASK') || line.includes('CELL-AGAIN')) {
    const again = line.includes('CELL-AGAIN')
    appendFileSync(MARKS, JSON.stringify({ what: 'cell', again, task: line.includes('CELL-TASK'), heard: line.includes('what the cell found'), reduces: line.includes('You reduce a document') }) + '\\n')
    return done({ status: 'completed', output: again ? 'what the cell found next' : 'what the cell found' })
  }
  const call = rootCalls()
  appendFileSync(MARKS, JSON.stringify({ what: 'root', told: /\\[Kept cells: 1 alive/.test(line) }) + '\\n')
  if (call % 2 === 1) return done({ status: 'completed', output: 'done' })
  const command = JSON.parse(readFileSync(${JSON.stringify(commands)}, 'utf8'))[call / 2]
  done({ status: 'tool_use', output: null, toolCalls: [{ id: 'c' + call, name: 'wsexec', arguments: { command, out: 'data/turn-' + (call / 2) + '.txt', timeout: 60 } }] })
})
`

const asked = []

const turn = async (command) => {
  asked.push(command)
  writeFileSync(commands, JSON.stringify(asked))
  const script = resolve(root, 'session.mjs')
  writeFileSync(script, session())
  const slot = takeSlot(CONFIG_FILE)
  const err = openSync(resolve(ws, 'spore.err'), 'a')
  enqueue(ws, 'go')
  try {
    spawn(RUNNER, ['--ws', ws, '--slot', slot.path, '--node', process.execPath, '--session', script, '--chatgpt-helper', CHATGPT_HELPER], {
      detached: true,
      stdio: ['ignore', 'ignore', err, slot.fd],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, XDG_CONFIG_HOME: root, OPENAI_API_SK: 'fake' }
    }).unref()
  } finally {
    closeSync(slot.fd)
    closeSync(err)
  }
  await until(() => readTurns(ws).length === asked.length && !readLock(ws)?.pid)
  expect(readTurns(ws).at(-1).stopReason, readFileSync(resolve(ws, 'spore.err'), 'utf8')).toBe('answer')
}

const keep = (dir) => [
  `mkdir -p ${dir}`,
  `printf 'CELL-%s\\n' TASK > ${dir}/in.md`,
  `"$SPORE_SPAWN" --precursor summarize --ws ${dir} --prompt in.md --answer data/out.txt --keep 2> ${dir}.err; echo $? > ${dir}.code`
].join(' && ')

const once = (dir) => keep(dir).replace(' --keep', '')

const ask = (dir, n) => [
  `printf 'CELL-%s\\n' AGAIN > ${dir}/q${n}.md`,
  `"$SPORE_SPAWN" --resume ${dir} --prompt q${n}.md --answer data/out${n}.txt 2> ${dir}.err${n}; echo $? > ${dir}.code${n}`
].join(' && ')

const rootCalls = () => readFileSync(marks, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(said => said.what === 'root')
const cellCalls = () => readFileSync(marks, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(said => said.what === 'cell')

const read = (path) => readFileSync(resolve(ws, path), 'utf8')
const kept = () => existsSync(resolve(ws, CELLS_DIR)) ? readdirSync(resolve(ws, CELLS_DIR)).sort() : []
const livingCells = (most) => writeFileSync(resolve(ws, 'spore.cmk'), read('spore.cmk').replace(/^---\n/, `---\nliving-cells: ${most}\n`))

beforeEach(() => {
  root = outsideRoot('kept-cells')
  ws = outsideWorkspace('kept-cells-ws', 'openai/slow')
  marks = resolve(root, 'marks.jsonl')
  commands = resolve(root, 'commands.json')
  asked.length = 0
  mkdirSync(resolve(ws, 'precursors'))
  copyFileSync(SUMMARIZE, resolve(ws, 'precursors/summarize.cmk'))
})

afterEach(async () => {
  if (readLock(ws)?.pid) {
    stop(ws)
    await until(() => !readLock(ws)?.pid)
  }
  rmSync(root, { recursive: true, force: true })
  rmSync(ws, { recursive: true, force: true })
})

describe('a cell spawned with --keep', () => {
  it('runs as any cell does, and leaves an entry holding its precursor as written and where it is', { timeout: 60000 }, async () => {
    await turn(keep('data/cache-bug'))

    expect(read('data/cache-bug.code').trim(), read('data/cache-bug.err')).toBe('0')
    expect(read('data/cache-bug/data/out.txt')).toBe('what the cell found')
    expect(kept()).toEqual(['cache-bug'])
    expect(read(`${CELLS_DIR}/cache-bug/precursor.cmk`)).toBe(readFileSync(SUMMARIZE, 'utf8'))
    const cell = JSON.parse(read(`${CELLS_DIR}/cache-bug/cell.json`))
    expect(cell).toMatchObject({ path: 'data/cache-bug', precursor: 'summarize' })
    expect(new Date(cell.madeAt).getTime()).toBeGreaterThan(0)
  })

  it('has an entry its spore reads and cannot change or remove', { timeout: 60000 }, async () => {
    await turn(keep('data/cache-bug'))
    await turn(`cat ${CELLS_DIR}/cache-bug/cell.json > data/seen.json; echo forged > ${CELLS_DIR}/cache-bug/precursor.cmk; echo $? > data/write.code; rm -rf ${CELLS_DIR}/cache-bug; echo $? > data/remove.code`)

    expect(JSON.parse(read('data/seen.json')).path).toBe('data/cache-bug')
    expect(read('data/write.code').trim()).not.toBe('0')
    expect(read('data/remove.code').trim()).not.toBe('0')
    expect(read(`${CELLS_DIR}/cache-bug/precursor.cmk`)).toBe(readFileSync(SUMMARIZE, 'utf8'))
  })

  it('is refused a name another kept cell has, and one more than living-cells allows, until a directory is deleted', { timeout: 120000 }, async () => {
    livingCells(1)
    await turn(keep('data/a'))
    expect(read('data/a.code').trim(), read('data/a.err')).toBe('0')

    await turn(keep('data/deeper/a'))
    expect(read('data/deeper/a.code').trim()).toBe('2')
    expect(read('data/deeper/a.err')).toMatch(/a cell named a is already kept — it is at data\/a/)
    expect(existsSync(resolve(ws, 'data/deeper/a/spawn.json'))).toBe(false)

    await turn(keep('data/b'))
    expect(read('data/b.code').trim()).toBe('2')
    expect(read('data/b.err')).toMatch(/1 cell is alive, the most this spore keeps — alive: a at data\/a/)
    expect(kept()).toEqual(['a'])

    await turn(`rm -rf data/a data/b data/b.err data/b.code && ${keep('data/b')}`)
    expect(read('data/b.code').trim(), read('data/b.err')).toBe('0')
    expect(kept()).toEqual(['b'])
  })

  it('is asked again in a later turn, going on from what it said, as what it was made from', { timeout: 90000 }, async () => {
    await turn(keep('data/cache-bug'))
    writeFileSync(resolve(ws, 'precursors/summarize.cmk'), readFileSync(SUMMARIZE, 'utf8').replace('You reduce a document to its essentials.', 'You count words.'))

    await turn(ask('data/cache-bug', 2))

    expect(read('data/cache-bug.code2').trim(), read('data/cache-bug.err2')).toBe('0')
    expect(read('data/cache-bug/data/out.txt')).toBe('what the cell found')
    expect(read('data/cache-bug/data/out2.txt')).toBe('what the cell found next')
    expect(cellCalls()).toEqual([
      { what: 'cell', again: false, task: true, heard: false, reduces: true },
      { what: 'cell', again: true, task: true, heard: true, reduces: true }
    ])
    expect(rootCalls().map(said => said.told)).toEqual([false, false, true, true])
    expect(JSON.parse(read('data/cache-bug/spawn.json'))).toMatchObject({ kept: true, resumed: true, answer: 'data/out2.txt', stopReason: 'answer' })
    expect(readTurns(resolve(ws, 'data/cache-bug')).map(one => one.stopReason)).toEqual(['answer', 'answer'])
    expect(readTurns(ws).at(-1).byPrecursor).toEqual({ summarize: { micros: 10000, rounds: 1, cells: 1 } })
  })

  it('is not asked again when it was not kept, or is not there', { timeout: 90000 }, async () => {
    await turn(once('data/once'))
    expect(read('data/once.code').trim(), read('data/once.err')).toBe('0')

    await turn(`${ask('data/once', 2)}; mkdir -p data/none; ${ask('data/none', 2)}`)

    expect(read('data/once.code2').trim()).toBe('2')
    expect(read('data/once.err2')).toMatch(/no kept cell is at data\/once — the cell that ran there was not spawned with --keep, and is spent/)
    expect(read('data/none.code2').trim()).toBe('2')
    expect(read('data/none.err2')).toMatch(/no kept cell is at data\/none — only a cell spawned with --keep is asked again/)
    expect(kept()).toEqual([])
  })

  it('is refused by a spore whose definition keeps none', { timeout: 60000 }, async () => {
    livingCells(0)
    await turn(keep('data/a'))

    expect(read('data/a.code').trim()).toBe('2')
    expect(read('data/a.err')).toMatch(/this spore keeps no cells: living-cells: 0 in its spore\.cmk/)
    expect(kept()).toEqual([])
    expect(existsSync(resolve(ws, 'data/a/spawn.json'))).toBe(false)
  })
})
