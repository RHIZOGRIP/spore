#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import minimist from 'minimist'
import mohdel from 'mohdel'

import { version } from '../../src/index.js'
import { provenance, runDir } from '../../conformance/record.js'
import { ARMS, CORPUS, SHAPED, TASKS, asking, buildItems, choiceOf, conversation, grade, readMessage, shapes, signTest, stageCorpus, toolChoiceOf, toolDefs } from './items.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const RESULTS = 'results.jsonl'
const MANIFEST = 'run.json'

const argv = minimist(process.argv.slice(2), {
  string: ['models', 'effort', 'tasks', 'arms', 'out', 'report', 'show'],
  boolean: ['help', 'dry'],
  default: { 'per-file': 5, seed: 1, concurrency: 6, 'max-cost': 5, effort: 'low', tasks: TASKS.join(','), arms: ARMS.join(','), out: resolve(ROOT, '..', 'tmp', 'read-shape') },
  alias: { h: 'help' }
})

const usage = `read-shape — does the shape of read's result change what a model gets right?

  node probes/read-shape/run.js --models openai/gpt-6-luna,fireworks/zai-glm-5.3
  node probes/read-shape/run.js --dry                 the items and what each arm costs in characters, no call
  node probes/read-shape/run.js --show <item id>      one item's conversation in every arm, no call
  node probes/read-shape/run.js --report <run dir>    the report of a run already made, no call

  --per-file N     items of each task per corpus file (default 5)
  --tasks a,b      ${TASKS.join(', ')} (default all)
  --arms a,b       ${ARMS.join(', ')} (default all)
  --effort E       the models' effort (default low; --effort '' sends none)
  --concurrency N  calls in flight (default 6)
  --max-cost D     no call starts once this many dollars are spent (default 5)
  --seed N         which items are drawn (default 1)
  --out DIR        where runs are kept (default ../tmp/read-shape)

Every item is asked in every arm, so arms are compared item by item. Calls go through
mohdel's in-process factory, with its catalog and keys.`

const fail = (message) => {
  console.error(`read-shape: ${message}`)
  process.exit(2)
}

function report (rows) {
  const out = []
  for (const model of [...new Set(rows.map(row => row.model))]) {
    const mine = rows.filter(row => row.model === model)
    const spent = mine.reduce((sum, row) => sum + (row.cost ?? 0), 0)
    out.push(`\n${model} — ${mine.length} calls, $${spent.toFixed(4)}`)
    const arms = ARMS.filter(arm => mine.some(row => row.arm === arm))
    for (const task of [...TASKS, 'all']) {
      const rowsOf = mine.filter(row => task === 'all' || row.task === task)
      if (!rowsOf.length) continue
      const by = Object.fromEntries(arms.map(arm => [arm, new Map(rowsOf.filter(row => row.arm === arm).map(row => [row.item, row]))]))
      out.push(`  ${task}`)
      for (const arm of arms) {
        const answered = [...by[arm].values()].filter(row => !row.error)
        const right = answered.filter(row => row.ok).length
        const tokens = answered.length ? Math.round(answered.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0) / answered.length) : 0
        const why = {}
        for (const row of answered) if (!row.ok) why[row.why] = (why[row.why] ?? 0) + 1
        const errors = by[arm].size - answered.length
        out.push(`    ${arm.padEnd(15)} ${String(right).padStart(3)}/${answered.length}${errors ? ` (${errors} errors)` : ''}  ~${tokens} input tokens  ${Object.entries(why).map(([k, v]) => `${k} ${v}`).join(', ')}`)
        if (arm === 'choose') {
          const asked = answered.filter(row => row.chose === true)
          const not = answered.filter(row => row.chose === false)
          out.push(`    ${''.padEnd(15)} asked for numbers ${asked.length}/${answered.length}: right ${asked.filter(row => row.ok).length}/${asked.length} when asked, ${not.filter(row => row.ok).length}/${not.length} when not`)
        }
      }
      for (let i = 0; i < arms.length; i++) {
        for (let j = i + 1; j < arms.length; j++) {
          let aOnly = 0
          let bOnly = 0
          for (const [item, a] of by[arms[i]]) {
            const b = by[arms[j]].get(item)
            if (!b || a.error || b.error) continue
            if (a.ok && !b.ok) aOnly++
            if (b.ok && !a.ok) bOnly++
          }
          out.push(`    ${arms[i]} only ${aOnly}, ${arms[j]} only ${bOnly}, sign test p=${signTest(aOnly, bOnly).toFixed(3)}`)
        }
      }
    }
  }
  return out.join('\n')
}

if (argv.help) {
  console.log(usage)
  process.exit(0)
}

if (argv.report) {
  const file = join(resolve(argv.report), RESULTS)
  if (!existsSync(file)) fail(`no ${RESULTS} in ${argv.report}`)
  console.log(report(readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))))
  process.exit(0)
}

const tasks = argv.tasks.split(',')
const arms = argv.arms.split(',')
for (const task of tasks) if (!TASKS.includes(task)) fail(`no task "${task}" — ${TASKS.join(', ')}`)
for (const arm of arms) if (!ARMS.includes(arm)) fail(`no arm "${arm}" — ${ARMS.join(', ')}`)
const models = argv.models ? argv.models.split(',') : []
if (!argv.dry && argv.show === undefined && !models.length) fail('--models is required — this calls models and costs money')

const run = runDir(resolve(argv.out), { model: models.length ? models.join('+') : 'dry' })
const ws = join(run, 'ws')
stageCorpus(ws)
const items = buildItems({ perFile: Number(argv['per-file']), seed: Number(argv.seed), tasks })
const tools = toolDefs(ws)
const originals = new Map(items.map(item => [item.file, readFileSync(join(CORPUS, item.file), 'utf8')]))
const shown = new Map()
for (const item of items) shown.set(item.id, shapes((await readMessage(ws, item.read)).content, (await readMessage(ws, { ...item.read, numbered: true })).content))

if (argv.show !== undefined) {
  const item = items.find(each => each.id === argv.show)
  if (!item) fail(`no item "${argv.show}" — ${items.slice(0, 3).map(each => each.id).join(', ')}, …`)
  for (const arm of arms) {
    console.log(`=== ${arm}`)
    const messages = arm === 'choose' ? asking(item) : conversation(item, shown.get(item.id)[arm])
    for (const message of messages) console.log(`--- ${message.role}\n${message.content || JSON.stringify(message.toolCalls)}`)
  }
  console.log(`=== truth\n${JSON.stringify(item.truth)}`)
  process.exit(0)
}

if (argv.dry) {
  console.log(`${items.length} items (${tasks.map(task => `${task} ${items.filter(item => item.task === task).length}`).join(', ')}), ${items.length * arms.reduce((sum, arm) => sum + (arm === 'choose' ? 2 : 1), 0)} calls per model`)
  for (const arm of arms.filter(each => SHAPED.includes(each))) {
    const chars = items.reduce((sum, item) => sum + shown.get(item.id)[arm].length, 0)
    console.log(`  ${arm.padEnd(15)} ${chars} characters of read results, ~${Math.round(chars / 4)} tokens per model`)
  }
  if (arms.includes('choose')) console.log(`  ${'choose'.padEnd(15)} a first call to see whether the model asks for numbers, then record or numbered-record`)
  console.log(`staged in ${run}`)
  process.exit(0)
}

mkdirSync(run, { recursive: true })
writeFileSync(join(run, MANIFEST), JSON.stringify({ ...provenance({ root: ROOT, model: models, spore: version }), effort: argv.effort, perFile: Number(argv['per-file']), seed: Number(argv.seed), tasks, arms, startedAt: new Date().toISOString() }, null, 2) + '\n')

const mo = await mohdel()
const jobs = models.flatMap(model => items.flatMap(item => arms.map(arm => ({ model, item, arm }))))
let spent = 0
let done = 0
let stopped = 0
const next = async () => {
  while (jobs.length) {
    if (spent >= Number(argv['max-cost'])) {
      stopped += jobs.length
      jobs.length = 0
      return
    }
    const { model, item, arm } = jobs.shift()
    const row = { model, arm, item: item.id, task: item.task, file: item.file }
    try {
      const effort = argv.effort ? { outputEffort: argv.effort } : {}
      let messages = conversation(item, shown.get(item.id)[arm])
      let first = 0
      if (arm === 'choose') {
        const asked = await mo.use(model).answer(asking(item), { tools, toolChoice: 'auto', ...effort })
        first = asked.cost ?? 0
        spent += first
        row.chose = choiceOf(asked)
        messages = row.chose === null ? null : conversation(item, shown.get(item.id)[row.chose ? 'numbered-record' : 'record'], { numbered: row.chose })
      }
      if (messages) {
        const result = await mo.use(model).answer(messages, { tools, toolChoice: toolChoiceOf(item), ...effort })
        Object.assign(row, grade(item, result, originals.get(item.file)), { output: result.output, toolCalls: result.toolCalls ?? [], inputTokens: result.inputTokens + (result.cacheReadInputTokens ?? 0) + (result.cacheWriteInputTokens ?? 0), cachedTokens: result.cacheReadInputTokens ?? 0, outputTokens: result.outputTokens, cost: first + (result.cost ?? 0), status: result.status })
        spent += result.cost ?? 0
      } else {
        Object.assign(row, { ok: false, why: 'no read', cost: first })
      }
    } catch (err) {
      Object.assign(row, { ok: false, error: `${err.type ?? err.name}: ${err.message}` })
    }
    appendFileSync(join(run, RESULTS), JSON.stringify(row) + '\n')
    done++
    if (done % 25 === 0) console.error(`${done} calls, $${spent.toFixed(4)}`)
  }
}
await Promise.all(Array.from({ length: Number(argv.concurrency) }, next))

console.log(report(readFileSync(join(run, RESULTS), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))))
if (stopped) console.log(`\nstopped at $${spent.toFixed(4)} with ${stopped} calls not made (--max-cost ${argv['max-cost']})`)
console.log(`\n${run}`)
