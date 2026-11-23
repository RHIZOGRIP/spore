/**
 * A cell, from `spawn` to the frame it leaves behind.
 *
 * The other delegation tests establish their pieces: planning refuses what it should,
 * the enzyme broker answers a confined shell, the fan-out helpers pick the next part.
 * None of them starts `native/<arch>/spore-spawn`, so nothing has established that confinement,
 * staging, the two brokers, the child's completion, the accounting and the final
 * records work when they run together.
 *
 * The provider is scripted and everything else is real, which is what lets this assert
 * the same thing twice: the model broker over its socket, Landlock around the worker,
 * the enzyme broker running a program the cell has no path to.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import http from 'node:http'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createModelServer, testSocket, suppliedKey } from './fixtures/model-server.js'
import { native } from '../src/native.js'
import { KEY_HEADER } from '../src/infra/socket-request.js'
import { readEvents, readTurns } from '../src/core/spore-dir.js'
import { outsideWorkspace } from './fixtures/outside-ws.js'
import { answers, calls, scriptedMo } from './fixtures/scripted-model.js'

const run = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const SPAWN = resolve(__dirname, '../native', process.arch, 'spore-spawn')

const UPPER = '#!/usr/bin/env node\nconst text = process.argv.slice(2).join(" ")\nprocess.stdout.write(text.toUpperCase() + "\\n")\n'

let root
let broker

const precursor = (name, body) => writeFileSync(resolve(root, 'precursors', `${name}.cmk`), body)

const spawnCell = async (args, env = {}) => {
  try {
    const { stdout, stderr } = await run(SPAWN, args, {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        SPORE_MODEL_SOCKET: broker.socketPath,
        SPORE_NODE: process.execPath,
        SPORE_WS: root,
        SPORE_SOCKET_DIR: native.sporeSocketDir(root),
        ...env
      }
    })
    return { code: 0, stdout, stderr }
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr }
  }
}

const cellFrame = (ws) => JSON.parse(readFileSync(resolve(root, ws, 'spawn.json'), 'utf8').trim().split('\n').at(-1))

const start = async (reply) => {
  broker = createModelServer({
    mo: scriptedMo(reply),
    socketPath: testSocket('cell-test'),
    limit: 10,
    key: suppliedKey(root)
  })
  await broker.listen()
}

beforeEach(() => {
  root = outsideWorkspace('cell-lifecycle')
  mkdirSync(resolve(root, 'precursors'), { recursive: true })
  mkdirSync(resolve(root, 'tools'), { recursive: true })
  mkdirSync(resolve(root, 'data/one'), { recursive: true })
  writeFileSync(resolve(root, 'tools/upper.mjs'), UPPER)
  chmodSync(resolve(root, 'tools/upper.mjs'), 0o755)
  writeFileSync(resolve(root, 'data/one/in.md'), 'shout hello')
  precursor('shout', '---\nname: shout\ntools: [read, write, wsexec]\nenzymes: [upper=tools/upper.mjs]\nrounds: [6, 8]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: discard\n---\n\nYou do what in.md asks.\n\n:::enzyme upper\nupper — takes text as arguments and writes it upper-cased on stdout.\n:::\n')
})

afterEach(async () => {
  await broker?.close()
  broker = null
  rmSync(root, { recursive: true, force: true })
})

describe('a cell that runs an enzyme', () => {
  it('reaches a program it has no path to, and says so in its frame', async () => {
    await start(async (input, round) => round === 0
      ? calls('wsexec', { command: 'node "$SPORE_ENZYME" upper hello', out: 'data/loud.txt' })
      : answers('done'))

    const r = await spawnCell(['--precursor', 'shout', '--ws', 'data/one', '--prompt', 'in.md', '--answer', 'data/out.txt'])
    expect(r.code, r.stderr).toBe(0)

    // The program lives in the parent's tree, outside every path the cell's ruleset
    // opens. `HELLO` inside the cell's workspace can only have arrived through the
    // broker that ran it on the cell's behalf.
    expect(readFileSync(resolve(root, 'data/one/data/loud.txt'), 'utf8')).toBe('HELLO\n')
    expect(readFileSync(resolve(root, 'data/one/data/out.txt'), 'utf8')).toBe('done')

    const frame = cellFrame('data/one')
    expect(frame.precursor).toBe('shout')
    expect(frame.answer).toBe('data/out.txt')
    expect(frame.stopReason).toBe('answer')
    expect(frame.rounds).toBe(2)
    expect(Object.keys(frame.enzymes)).toEqual(['upper'])

    // What the cell spent, counted in the process that holds the key. The parent
    // never sees the cell's own arithmetic; it sees its broker's.
    expect(broker.ledger.children).toBeCloseTo(0.02)
    expect(frame.cost).toBeCloseTo(0.02)

    const [turn] = readTurns(resolve(root, 'data/one'))
    expect(turn.stopReason).toBe('answer')
    expect(turn.concluded).toBe(true)
    expect(existsSync(resolve(root, 'data/one/lock'))).toBe(true)
    expect(readFileSync(resolve(root, 'data/one/lock'), 'utf8')).toBe('')
  })

  it('runs it with the inline budget the command that started the cell was told', async () => {
    writeFileSync(resolve(root, 'tools/budget.mjs'), '#!/usr/bin/env node\nprocess.stdout.write(process.env.SPORE_INLINE_BYTES + "\\n")\n')
    chmodSync(resolve(root, 'tools/budget.mjs'), 0o755)
    precursor('sized', '---\nname: sized\ntools: [read, write, wsexec]\nenzymes: [budget=tools/budget.mjs]\nrounds: [6, 8]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: discard\n---\n\nYou do what in.md asks.\n\n:::enzyme budget\nbudget — writes the inline budget it was told on stdout.\n:::\n')
    await start(async (input, round) => round === 0
      ? calls('wsexec', { command: 'node "$SPORE_ENZYME" budget', out: 'data/budget.txt' })
      : answers('done'))

    const r = await spawnCell(['--precursor', 'sized', '--ws', 'data/one', '--prompt', 'in.md', '--answer', 'data/out.txt'], { SPORE_INLINE_BYTES: '4096' })
    expect(r.code, r.stderr).toBe(0)
    expect(readFileSync(resolve(root, 'data/one/data/budget.txt'), 'utf8')).toBe('4096\n')
  })
})

describe('a cell that is confined', () => {
  it('cannot read the enzyme it runs, which lives in the parent\'s tree', async () => {
    await start(async (input, round) => round === 0
      ? calls('wsexec', { command: `cat "${resolve(root, 'tools/upper.mjs')}"`, out: 'data/seen.txt', err: 'data/why.txt' })
      : answers('blocked'))

    const r = await spawnCell(['--precursor', 'shout', '--ws', 'data/one', '--prompt', 'in.md', '--answer', 'data/out.txt'])
    expect(r.code, r.stderr).toBe(0)
    expect(readFileSync(resolve(root, 'data/one/data/seen.txt'), 'utf8')).toBe('')
    expect(readFileSync(resolve(root, 'data/one/data/why.txt'), 'utf8')).toMatch(/Permission denied/)
  })

  // Copied into a workspace where nothing else of spore is reachable, so a relative
  // import would break at the far end.
  it('is staged an enzyme client that imports only node builtins', async () => {
    await start(async () => answers('done'))

    const r = await spawnCell(['--precursor', 'shout', '--ws', 'data/one', '--prompt', 'in.md', '--answer', 'data/out.txt'])
    expect(r.code, r.stderr).toBe(0)
    const source = readFileSync(resolve(root, 'data/one/enzyme.js'), 'utf8')
    const imports = [...source.matchAll(/^import .* from '(.+)'$/gm)].map(m => m[1])
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.every(spec => spec.startsWith('node:'))).toBe(true)
  })

  it('cannot write the tree it was spawned from', async () => {
    await start(async (input, round) => round === 0
      ? calls('wsexec', { command: 'echo escaped > ../../../reached.txt', out: 'data/tried.txt', err: 'data/why.txt' })
      : answers('blocked'))

    const r = await spawnCell(['--precursor', 'shout', '--ws', 'data/one', '--prompt', 'in.md', '--answer', 'data/out.txt'])
    expect(r.code, r.stderr).toBe(0)
    // Its own `wsexec` is the most writable thing it has, and the parent's workspace
    // is still out of reach. Without this the tests above would pass just as well
    // against a cell that was never confined at all.
    expect(existsSync(resolve(root, 'reached.txt'))).toBe(false)
    expect(readFileSync(resolve(root, 'data/one/data/why.txt'), 'utf8')).toMatch(/Permission denied/)
  })
})

describe('a cell whose answer goes deeper than data/', () => {
  it('has the directory made for it, so its answer is not lost after the work is done', async () => {
    precursor('nested', '---\nname: nested\ntools: []\nrounds: [3, 4]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: keep\n---\n\nYou answer.\n')
    await start(async () => answers('found three'))

    const r = await spawnCell(['--precursor', 'nested', '--ws', 'data/one', '--prompt', 'in.md', '--answer', 'data/audit/pass/out.txt'])
    expect(r.code, r.stderr).toBe(0)
    expect(cellFrame('data/one').answer).toBe('data/audit/pass/out.txt')
    expect(readFileSync(resolve(root, 'data/one/data/audit/pass/out.txt'), 'utf8')).toBe('found three')
  })
})

describe('a cell that ran out of room', () => {
  const wrapping = (name, onWrap) => precursor(name,
    `---\nname: ${name}\ntools: [read, write, wsexec]\nrounds: [1, 4]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: ${onWrap}\n---\n\nYou do what in.md asks.\n`)

  const untilItWraps = async (input, round) => round === 0
    ? calls('write', { path: 'data/partial.txt', content: 'half' })
    : answers('wrapped up early')

  it('keeps the wrapped answer when the precursor says keep', async () => {
    wrapping('kept', 'keep')
    await start(untilItWraps)

    const r = await spawnCell(['--precursor', 'kept', '--ws', 'data/one', '--prompt', 'in.md', '--answer', 'data/out.txt'])
    expect(r.code, r.stderr).toBe(0)

    const frame = cellFrame('data/one')
    expect(frame.stopReason).toBe('soft:rounds')
    expect(frame.answer).toBe('data/out.txt')
    expect(frame.continuation).toBe(null)
    expect(readFileSync(resolve(root, 'data/one/data/out.txt'), 'utf8')).toBe('wrapped up early')
  })

  it('discards it when it says discard, and owes the parent a continuation instead', async () => {
    wrapping('dropped', 'discard')
    await start(untilItWraps)

    const r = await spawnCell(['--precursor', 'dropped', '--ws', 'data/one', '--prompt', 'in.md', '--answer', 'data/out.txt'])
    // A cell with no answer exits nonzero: the exit code is what a fan-out reads.
    expect(r.code).toBe(1)

    const frame = cellFrame('data/one')
    expect(frame.stopReason).toBe('soft:rounds')
    expect(frame.answer).toBe(null)
    expect(existsSync(resolve(root, 'data/one/data/out.txt'))).toBe(false)

    // The turn still says it answered — it did, and the spawn is what discarded it.
    // The frame and the turn record disagree on purpose, which is why the fan-out
    // reads the frame.
    const [turn] = readTurns(resolve(root, 'data/one'))
    expect(turn.concluded).toBe(true)

    const continuation = readFileSync(resolve(root, 'data/one', frame.continuation), 'utf8')
    expect(continuation).toMatch(/# Stopped: soft:rounds/)
    expect(continuation).toMatch(/its answer was discarded/)
    expect(continuation).toMatch(/`write` .* — data\/partial\.txt/)
    expect(continuation).toMatch(/`data\/partial\.txt` \(4 B\)/)
    expect(continuation).toMatch(/precursors\/dropped\.cmk/)
  })

  it('stops at the hard bound with nothing to hand back', async () => {
    precursor('stubborn', '---\nname: stubborn\ntools: [read, write, wsexec]\nrounds: [1, 2]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: keep\n---\n\nYou do what in.md asks.\n')
    await start(async () => calls('write', { path: 'data/partial.txt', content: 'half' }))

    const r = await spawnCell(['--precursor', 'stubborn', '--ws', 'data/one', '--prompt', 'in.md', '--answer', 'data/out.txt'])
    expect(r.code).toBe(1)

    const frame = cellFrame('data/one')
    expect(frame.stopReason).toBe('hard:rounds')
    expect(frame.answer).toBe(null)
    const continuation = readFileSync(resolve(root, 'data/one', frame.continuation), 'utf8')
    expect(continuation).toMatch(/# Stopped: hard:rounds/)
    expect(continuation).toMatch(/No answer was produced/)

    const [turn] = readTurns(resolve(root, 'data/one'))
    expect(turn.stopReason).toBe('hard:rounds')
    expect(turn.concluded).toBe(false)
  })
})

// The tree's source socket, standing in for the runner's: it answers `/list` within a view the
// way the runner does, refusing a source the tree was not granted.
const sourceSocket = async (granted) => {
  const socketPath = testSocket('source-test')
  const asked = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      asked.push({ path: req.url, key: req.headers[KEY_HEADER], body })
      const outside = body.view.sources.find(name => !granted.includes(name))
      res.writeHead(outside ? 403 : 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(outside
        ? { message: `the view names "${outside}", which this spore was not granted`, type: 'SOURCE_NOT_GRANTED', detail: `its definition lists ${granted.join(', ')}` }
        : { sources: body.view.sources.map(name => ({ name, scope: {} })) }))
    })
  })
  await new Promise(resolve => server.listen(socketPath, resolve))
  return {
    socketPath,
    asked,
    close: () => new Promise(resolve => server.close(() => { try { unlinkSync(socketPath) } catch {} resolve() }))
  }
}

describe('a cell that names sources', () => {
  const reader = (sources) => precursor('reader', `---\nname: reader\ntools: [read, write, wsexec]\nsources: [${sources}]\npubmed.db: [papers]\nrounds: [4, 6]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: discard\n---\n\nYou read.\n`)
  const args = ['--precursor', 'reader', '--ws', 'data/one', '--prompt', 'in.md', '--answer', 'data/out.txt']

  it('is refused under a tree granted no sources', async () => {
    await start(async () => answers('done'))
    reader('pubmed')

    const r = await spawnCell(args)
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/precursor reader names sources, and this spore was granted none/)
    expect(existsSync(resolve(root, 'data/one/spawn.json'))).toBe(false)
  })

  it('is refused at spawn when it names a source the tree was not granted', async () => {
    await start(async () => answers('done'))
    reader('pubmed, other')
    const sources = await sourceSocket(['pubmed'])
    try {
      const r = await spawnCell(args, { SPORE_SOURCE_SOCKET: sources.socketPath })
      expect(r.code).toBe(2)
      expect(r.stderr).toMatch(/precursor reader: the view names "other", which this spore was not granted/)
      expect(existsSync(resolve(root, 'data/one/spawn.json'))).toBe(false)
    } finally {
      await sources.close()
    }
  })

  it('is given its view of the tree\'s sources, checked once with the tree\'s key', async () => {
    await start(async (input, round) => round === 0
      ? calls('wsexec', { command: 'printf %s "$SPORE_SOURCES"', out: 'data/view.json' })
      : answers('done'))
    reader('pubmed')
    const key = readFileSync(resolve(root, 'tree.key'), 'utf8')
    const sources = await sourceSocket(['pubmed', 'other'])
    try {
      const r = await spawnCell(args, { SPORE_SOURCE_SOCKET: sources.socketPath })
      expect(r.code, r.stderr).toBe(0)
      const view = { sources: ['pubmed'], scopes: { pubmed: { db: ['papers'] } } }
      expect(sources.asked).toEqual([{ path: '/list', key, body: { view } }])
      expect(JSON.parse(readFileSync(resolve(root, 'data/one/data/view.json'), 'utf8'))).toEqual(view)
    } finally {
      await sources.close()
    }
  })
})

describe('a cell whose precursor names an answer check', () => {
  // The check reads what it needs from where its spore keeps it, beside `checks/`.
  const TOTALS = "const { readFileSync } = require('node:fs')\nconst { join } = require('node:path')\nconst { key } = JSON.parse(readFileSync(join(__dirname, '../data/schema.json'), 'utf8'))\nlet said = ''\nprocess.stdin.on('data', d => { said += d }).on('end', () => console.log(JSON.stringify(said.includes(key) ? { ok: true } : { tell: 'the answer has no ' + key })))\n"
  const args = (part = 'one') => ['--precursor', 'extract', '--ws', `data/${part}`, '--prompt', 'in.md', '--answer', 'data/out.txt']
  const checked = (part = 'one') => readEvents(resolve(root, 'data', part), { event: 'answer_check' })
  const extract = (lines = 'check: totals\ntotals.with: [data/schema.json]\n') => precursor('extract',
    `---\nname: extract\ntools: [read, write, wsexec]\n${lines}rounds: [6, 8]\ncost: [0.10, 0.15]\nwall: [2m, 3m]\non-wrap: discard\n---\n\nYou do what in.md asks.\n`)

  beforeEach(() => {
    mkdirSync(resolve(root, 'checks'), { recursive: true })
    writeFileSync(resolve(root, 'checks/totals.check.js'), TOTALS)
    writeFileSync(resolve(root, 'data/schema.json'), '{"key":"total"}')
    extract()
  })

  it('has an answer its check refuses sent back once, and its second answer is the one written', async () => {
    const seen = []
    await start(async (input, round) => {
      seen.push(input)
      return [answers('{"sum": 3}'), answers('{"total": 3}')][round]
    })

    const r = await spawnCell(args())
    expect(r.code, r.stderr).toBe(0)

    expect(seen).toHaveLength(2)
    expect(JSON.stringify(seen[1])).toContain('[System: before this answer goes out: the answer has no total')
    expect(readFileSync(resolve(root, 'data/one/data/out.txt'), 'utf8')).toBe('{"total": 3}')
    expect(checked()).toMatchObject([
      { round: 0, by: 'program', check: 'totals', verdict: 'tell', tell: 'the answer has no total', told: true, afterTelling: false },
      { round: 1, by: 'program', check: 'totals', verdict: 'ok', told: false, afterTelling: true }
    ])
    const frame = cellFrame('data/one')
    expect(frame.rounds).toBe(2)
    expect(frame.check).toMatchObject({ name: 'totals', hash: expect.stringMatching(/^[0-9a-f]{16}$/) })
  })

  it('answers in one round when its check passes the answer', async () => {
    await start(async () => answers('{"total": 3}'))

    const r = await spawnCell(args())
    expect(r.code, r.stderr).toBe(0)
    expect(cellFrame('data/one').rounds).toBe(1)
    expect(checked()).toMatchObject([{ round: 0, check: 'totals', verdict: 'ok', told: false }])
  })

  it('runs a check that is a program of its own', async () => {
    writeFileSync(resolve(root, 'checks/shell.check'), '#!/bin/sh\ngrep -q total && echo \'{"ok":true}\' || echo \'{"tell":"no total"}\'\n')
    chmodSync(resolve(root, 'checks/shell.check'), 0o755)
    extract('check: shell\n')
    await start(async (input, round) => [answers('nothing'), answers('total: 3')][round])

    const r = await spawnCell(args())
    expect(r.code, r.stderr).toBe(0)
    expect(readFileSync(resolve(root, 'data/one/data/out.txt'), 'utf8')).toBe('total: 3')
    expect(checked()).toMatchObject([{ check: 'shell', verdict: 'tell', told: true }, { check: 'shell', verdict: 'ok' }])
  })

  it('is not checked by its spore\'s own answer check when its precursor names none', async () => {
    writeFileSync(resolve(root, 'checks/answer.check.js'), "console.log(JSON.stringify({ tell: 'never' }))\n")
    extract('')
    await start(async () => answers('{"sum": 3}'))

    const r = await spawnCell(args())
    expect(r.code, r.stderr).toBe(0)
    const frame = cellFrame('data/one')
    expect(frame.rounds).toBe(1)
    expect(frame.check).toBeUndefined()
    expect(checked()).toEqual([])
  })

  it('is refused when its precursor names a check its spore does not keep', async () => {
    extract('check: absent\n')
    await start(async () => answers('unreached'))

    const r = await spawnCell(args())
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/precursor extract names a check its spore does not keep — expected checks\/absent\.check or checks\/absent\.check\.js/)
    expect(existsSync(resolve(root, 'data/one/spawn.json'))).toBe(false)
  })

  it('cannot write its check or what the check needs', async () => {
    await start(async (input, round) => round === 0
      ? calls('wsexec', { command: `echo '{"key":"sum"}' > '${resolve(root, 'data/schema.json')}'; echo 'console.log("{\\"ok\\":true}")' > '${resolve(root, 'checks/totals.check.js')}'`, out: 'data/tried.txt', err: 'data/why.txt' })
      : [answers('{"sum": 3}'), answers('{"sum": 4}')][round - 1])

    const r = await spawnCell(args())
    expect(r.code, r.stderr).toBe(0)
    expect(readFileSync(resolve(root, 'data/schema.json'), 'utf8')).toBe('{"key":"total"}')
    expect(readFileSync(resolve(root, 'checks/totals.check.js'), 'utf8')).toBe(TOTALS)
    expect(checked()).toMatchObject([{ verdict: 'tell', told: true }, { verdict: 'tell', afterTelling: true }])
  })

  it('lets the answer out when the check changed after the cell started', async () => {
    await start(async (input, round) => {
      if (round === 0) writeFileSync(resolve(root, 'data/schema.json'), '{"key":"sum"}')
      return answers('{"total": 3}')
    })

    const r = await spawnCell(args())
    expect(r.code, r.stderr).toBe(0)
    expect(cellFrame('data/one').rounds).toBe(1)
    expect(checked()).toMatchObject([{ verdict: 'failed', told: false }])
    expect(checked()[0].why).toMatch(/totals changed since this cell started/)
  })

  it('gives two cells of one fan-out the same check, hashed at each spawn', async () => {
    mkdirSync(resolve(root, 'data/two'), { recursive: true })
    writeFileSync(resolve(root, 'data/two/in.md'), 'extract')
    await start(async () => answers('{"total": 3}'))

    expect((await spawnCell(args('one'))).code).toBe(0)
    expect((await spawnCell(args('two'))).code).toBe(0)
    expect(cellFrame('data/two').check).toEqual(cellFrame('data/one').check)
    expect(checked('two')).toMatchObject([{ check: 'totals', verdict: 'ok' }])
  })
})
