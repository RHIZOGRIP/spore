import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createCallTrail } from '../src/core/call-record.js'
import { hostState } from '../src/core/spore-dir.js'
import { superGrants } from '../src/core/workspace.js'
import { makeTools } from '../src/tools/make-tools.js'
import { shownToModel } from './fixtures/as-shown.js'
import { outsideRoot } from './fixtures/outside-ws.js'

const SANDBOX = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../src/isolation/sandbox.js')).href

let root
let spore
let cell
let corpus
let here
let granted

beforeEach(() => {
  root = outsideRoot('super-reach')
  spore = resolve(root, 'main')
  cell = resolve(root, 'cell')
  corpus = resolve(root, 'corpus')
  here = resolve(root, 'here')
  for (const dir of [resolve(spore, 'data'), resolve(spore, 'home'), resolve(spore, 'precursors'), resolve(cell, 'data'), corpus, here]) mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(spore, 'spore.cmk'), 'the definition')
  writeFileSync(resolve(spore, 'precursors', 'tidy.cmk'), 'the dream')
  writeFileSync(resolve(corpus, 'a.md'), 'read only')
  writeFileSync(resolve(here, 'b.md'), 'worked on')
  symlinkSync(corpus, resolve(spore, 'corpus'))
  symlinkSync(here, resolve(spore, 'here'))
  granted = superGrants(cell, {
    spore,
    reads: [{ name: 'corpus', path: corpus }, { name: 'here', path: here }],
    writes: [resolve(spore, 'data'), resolve(spore, 'home')]
  })
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('a super cell', () => {
  it('writes through its tools what the spore writes of its own, and nothing else of it', async () => {
    const built = makeTools(cell, 50000, createCallTrail(cell, { runId: 'test', state: hostState(cell) }), { reads: granted.reads, writes: granted.writes })
    const tools = shownToModel(built.fns)

    expect(JSON.parse(await tools.write({ path: 'spore/data/note.md', content: 'kept' })).exit).toBe(0)
    expect(readFileSync(resolve(spore, 'data/note.md'), 'utf8')).toBe('kept')
    expect(await tools.read({ path: 'spore/here/b.md' })).toContain('worked on')

    for (const path of ['spore/precursors/tidy.cmk', 'spore/spore.cmk', 'spore/here/b.md', 'spore/corpus/a.md']) {
      expect(await tools.write({ path, content: 'changed' })).toMatch(/reads and never writes/)
    }
    expect(readFileSync(resolve(spore, 'precursors/tidy.cmk'), 'utf8')).toBe('the dream')
    expect(readFileSync(resolve(here, 'b.md'), 'utf8')).toBe('worked on')
  })

  it('is held to the same by the kernel, whatever it runs', () => {
    const script = `
      import { readFileSync, writeFileSync } from 'node:fs'
      import { sandbox } from '${SANDBOX}'
      const [cell, granted, spore, corpus, here] = process.argv.slice(1)
      const { reads, writes } = JSON.parse(granted)
      sandbox(cell, { writeDir: 'data', extraWritePaths: writes.map(w => w.path), extraReadPaths: reads.map(r => r.path) })
      const write = (path) => { try { writeFileSync(path, 'x'); return 'written' } catch (err) { return err.code } }
      console.log(JSON.stringify({
        data: write(cell + '/spore/data/k'),
        home: write(cell + '/spore/home/k'),
        precursors: write(cell + '/spore/precursors/k'),
        definition: write(cell + '/spore/spore.cmk'),
        corpus: write(corpus + '/k'),
        here: write(here + '/k'),
        read: [readFileSync(spore + '/precursors/tidy.cmk', 'utf8'), readFileSync(corpus + '/a.md', 'utf8'), readFileSync(here + '/b.md', 'utf8')]
      }))
    `
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script, cell, JSON.stringify(granted), spore, corpus, here], { encoding: 'utf8' })
    const tried = JSON.parse(out)
    expect(tried).toMatchObject({ data: 'written', home: 'written', read: ['the dream', 'read only', 'worked on'] })
    for (const refused of ['precursors', 'definition', 'corpus', 'here']) expect(tried[refused]).toMatch(/EACCES|EPERM/)
    expect(existsSync(resolve(spore, 'precursors/k'))).toBe(false)
    expect(readFileSync(resolve(spore, 'spore.cmk'), 'utf8')).toBe('the definition')
  })
})
