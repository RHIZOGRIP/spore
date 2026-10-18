import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { CombinedAutocompleteProvider, Input, isKeyRelease, Markdown, matchesKey, ProcessTerminal, ScrollView, SelectList, truncateToWidth, TuiAltScreen, visibleWidth, VStack, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { applyEvent, changeText, createLive, curate, durationText, extendTurn, grantOf, list, liveIn, loadMohdelEnvironment, outbox, pause, paused, readInbox, readTurns, RUNNING, send, SERVICE_STATE_DIR, show, stateOf, stop, switchModel, unpause, upstream, watchAll, wrapTurn } from '@rhizogrip/spore'
import chalk from 'chalk'

import { runningJob, scheduleLine } from '../src/dispatch.js'
import { COMMANDS, parseCommand } from './commands.js'
import { history, markOf } from './conversation.js'
import { changeOf, counts, hunks } from './diff.js'
import { printable } from './printable.js'
import { PromptEditor } from './prompt.js'
import { Answer } from './answer.js'
import { matching, priceText, sporeLabel, statusParts } from './status.js'

const REFRESH_MS = 1000
const MARK_TONE = { running: chalk.yellow, ok: chalk.green, exit: chalk.yellow, failed: chalk.red }
const TWICE_MS = 1500
const NOTICE_MS = 4000
const LONG_TURN_MS = 60_000
const REMEMBERED = join(dirname(SERVICE_STATE_DIR), 'tui.json')

const dim = chalk.dim
const selectTheme = {
  selectedPrefix: chalk.cyan,
  selectedText: chalk.bold,
  description: dim,
  scrollInfo: dim,
  noMatch: dim
}
const editorTheme = { borderColor: dim, selectList: selectTheme }
const markdownTheme = {
  heading: chalk.bold,
  link: chalk.cyan,
  linkUrl: dim,
  code: chalk.yellow,
  codeBlock: (s) => s,
  codeBlockBorder: dim,
  quote: chalk.italic,
  quoteBorder: dim,
  hr: dim,
  listBullet: chalk.cyan,
  bold: chalk.bold,
  italic: chalk.italic,
  strikethrough: chalk.strikethrough,
  underline: chalk.underline
}

export function rememberedSpore () {
  if (!existsSync(REMEMBERED)) return null
  return JSON.parse(readFileSync(REMEMBERED, 'utf8')).ws
}

export function mostRecentSpore () {
  const latest = (row) => row.last?.endedAt ?? ''
  return list().workspaces.sort((a, b) => latest(b).localeCompare(latest(a)))[0]?.ws ?? null
}

const remember = (ws) => {
  mkdirSync(dirname(REMEMBERED), { recursive: true })
  writeFileSync(REMEMBERED, JSON.stringify({ ws }))
}

const lines = (text, width, style = (s) => s) => wrapTextWithAnsi(text, Math.max(1, width)).map(line => style(line))

const MOST_DIFF_LINES = 40
const DIFF_STYLE = { '+': chalk.green, '-': chalk.red, ' ': dim, '…': dim }

function changeLines (tool, change, { expanded, width, mark, time }) {
  const { added, removed } = counts(change.diff)
  const tally = [added ? chalk.green(`+${added}`) : '', removed ? chalk.red(`−${removed}`) : ''].filter(Boolean).join(' ')
  const head = truncateToWidth(`${mark} ${tool.name} ${printable(change.path)} ${tally}${time}`, width)
  if (!expanded) return [head]
  const shown = change.whole ? change.diff : hunks(change.diff)
  const body = shown.slice(0, MOST_DIFF_LINES).map(line => truncateToWidth(`    ${DIFF_STYLE[line.op](line.op === '…' ? '…' : `${line.op} ${printable(line.text)}`)}`, width))
  const more = shown.length > MOST_DIFF_LINES ? [dim(`    … ${shown.length - MOST_DIFF_LINES} more lines`)] : []
  return [head, ...body, ...more]
}

function toolLine (tool, { expanded, width }) {
  const { text, tone } = markOf(tool)
  const mark = MARK_TONE[tone](text)
  const time = tool.done ? dim(` ${durationText(tool.durationMs)}`) : ''
  const change = changeOf(tool)
  if (change) return changeLines(tool, change, { expanded, width, mark, time })
  const args = JSON.stringify(tool.args)
  if (!expanded) return [truncateToWidth(`${mark} ${tool.name} ${dim(args)}${time}`, width)]
  return [`${mark} ${tool.name}${time}`, ...lines(args, width - 4, dim).map(line => `    ${line}`)]
}

class Conversation {
  constructor ({ renderTool }) {
    this.items = []
    this.live = null
    this.expanded = false
    this.renderTool = renderTool
    this.answers = new WeakMap()
    this.liveAnswer = new Markdown('', 0, 0, markdownTheme)
  }

  markdown (item) {
    if (!this.answers.has(item)) this.answers.set(item, new Answer(item.text, markdownTheme))
    return this.answers.get(item)
  }

  lastAnswer () {
    return [...this.items].reverse().find(item => item.kind === 'answer')
  }

  /** The code blocks of the last answer, numbered on screen from 1. */
  lastBlocks () {
    const last = this.lastAnswer()
    return last ? this.markdown(last).blocks : []
  }

  render (width) {
    const out = []
    if (!this.items.length && !this.live) out.push(dim('nothing said yet — write below, / for commands'))
    const last = this.lastAnswer()
    for (const item of this.items) {
      if (item.kind === 'said') {
        const from = item.origin === 'terminal' ? chalk.cyan('>') : chalk.cyan(`${item.origin} >`)
        out.push('', ...lines(`${from} ${chalk.bold(item.text)}${item.waiting && !this.live ? dim('  (not read yet)') : ''}`, width))
      } else if (item.kind === 'answer') {
        const answer = this.markdown(item)
        answer.label(item === last)
        out.push('', ...answer.render(width))
      } else if (item.kind === 'end') {
        const how = [item.stopReason, item.error].filter(Boolean).join(' · ')
        const took = item.durationMs === null ? '' : ` · ${durationText(item.durationMs)}`
        const label = `── turn ${item.turnNo} · ${how} · ${item.rounds ?? 0} rounds · $${(item.treeUsd ?? 0).toFixed(4)}${took} `
        out.push(dim(truncateToWidth(label + '─'.repeat(Math.max(0, width - visibleWidth(label))), width)))
        if (item.error && item.detail) out.push(...lines(`   ${item.detail.split('\n')[0]}`, width, chalk.red))
      }
    }
    if (this.live) {
      out.push('')
      if (this.live.annotation) out.push(...lines(printable(this.live.annotation), width, dim))
      for (const note of this.live.notes) out.push(...lines(printable(note.text), width, note.kind === 'thought' ? chalk.italic : dim))
      for (const call of this.live.calls) out.push(...(this.renderTool?.(call, { expanded: this.expanded, width }) ?? toolLine(call, { expanded: this.expanded, width })))
      if (this.live.text.trim()) {
        this.liveAnswer.setText(printable(this.live.text))
        if (this.live.notes.length || this.live.calls.length) out.push('')
        out.push(...this.liveAnswer.render(width))
      } else if (!this.live.complete && this.live.calls.every(call => call.done)) {
        out.push(dim(`thinking${'.'.repeat(1 + Math.floor(Date.now() / 1000) % 3)}`))
      }
    }
    out.push('')
    return out
  }

  invalidate () {
    this.liveAnswer.invalidate()
  }
}

class StatusLine {
  constructor () {
    this.notice = ''
    this.parts = []
  }

  render (width) {
    return [
      ...(this.notice ? lines(this.notice, width, chalk.yellow) : []),
      truncateToWidth(dim(this.parts.join(' · ')), width)
    ]
  }

  invalidate () {}
}

function framed (title, body, footer, width) {
  const inner = Math.max(1, width - 4)
  const edge = (left, text, style, right) => {
    const label = ` ${truncateToWidth(text, Math.max(1, width - 6), '')} `
    return dim(`${left}─`) + style(label) + dim(`${'─'.repeat(Math.max(0, width - 3 - visibleWidth(label)))}${right}`)
  }
  const row = (line) => {
    const fitted = truncateToWidth(line, inner, '')
    return `${dim('│')} ${fitted}${' '.repeat(Math.max(0, inner - visibleWidth(fitted)))} ${dim('│')}`
  }
  return [edge('╭', title, chalk.bold, '╮'), row(''), ...body.map(row), row(''), edge('╰', footer, dim, '╯')]
}

class Picker {
  constructor ({ title = 'open a spore', header = [], items, onSelect, onCancel }) {
    this.title = title
    this.header = header
    this.items = items
    this.onSelect = onSelect
    this.onCancel = onCancel
    this.filter = new Input({ prompt: '> ', placeholder: 'type to filter', placeholderStyle: dim })
    this.filter.focused = true
    this.list = this.listOf(items)
  }

  listOf (items) {
    const list = new SelectList(items, 12, selectTheme, { minPrimaryColumnWidth: 16, maxPrimaryColumnWidth: 56 })
    list.onSelect = this.onSelect
    list.onCancel = this.onCancel
    return list
  }

  handleInput (data) {
    if (matchesKey(data, 'up') || matchesKey(data, 'down') || matchesKey(data, 'enter') || matchesKey(data, 'escape')) return this.list.handleInput(data)
    this.filter.handleInput(data)
    this.list = this.listOf(matching(this.items, this.filter.getValue()))
  }

  render (width) {
    const inner = Math.max(1, width - 4)
    const above = this.header.length ? [...this.header.flatMap(line => lines(line, inner, dim)), ''] : []
    return framed(this.title, [...above, ...this.filter.render(inner), '', ...this.list.render(inner)], '↑↓ enter · esc', width)
  }

  invalidate () {
    this.filter.invalidate()
    this.list.invalidate()
  }
}

class Panel {
  constructor (title, text, onClose, { confirming = null, onConfirm = null } = {}) {
    this.title = title
    this.text = text
    this.onClose = onClose
    this.confirming = confirming
    this.onConfirm = onConfirm
  }

  handleInput (data) {
    if (this.onConfirm && matchesKey(data, 'enter')) return this.onConfirm()
    if (matchesKey(data, 'escape') || matchesKey(data, 'enter') || matchesKey(data, 'q')) this.onClose()
  }

  render (width) {
    const footer = this.onConfirm ? `enter to ${this.confirming} · esc to leave it` : 'esc to close'
    return framed(this.title, this.text.split('\n').flatMap(line => lines(line, Math.max(1, width - 4))), footer, width)
  }

  invalidate () {}
}

/** A choice made before any spore is open: the value picked, or null when it was left. */
export function choose ({ title, header = [], items, terminal = new ProcessTerminal() }) {
  const tui = new TuiAltScreen(terminal)
  return new Promise(resolve => {
    const done = (value) => {
      tui.stop({ preserveScreen: true })
      resolve(value)
    }
    const picker = new Picker({ title, header, items, onSelect: (item) => done(item.value), onCancel: () => done(null) })
    tui.addInputListener((data) => {
      if (matchesKey(data, 'ctrl+c') || matchesKey(data, 'ctrl+d')) {
        done(null)
        return { consume: true }
      }
      return undefined
    })
    tui.setLayoutRoot(new VStack([{ component: picker, basis: 'auto' }]))
    tui.setFocus(picker)
    tui.start()
  })
}

const ago = (iso, now) => (iso ? `${durationText(now - Date.parse(iso))} ago` : 'never')

/**
 * Runs the terminal on `ws` until it is left; resolves with the exit code. `commands` are added
 * to the built-in ones, each `{ name, description, argumentHint?, run(args, context) }`, the
 * context being `{ ws, notice, send, outside(fn), confirm(title, text, confirming), running() }`:
 * `outside` runs `fn` on the bare terminal (a pager, an editor) and comes back, `confirm` resolves
 * true on Enter. `renderTool(tool, { expanded, width })` draws a tool call as lines, or returns
 * null for the default; `greeting` is a line shown as the screen opens.
 */
export async function runTui ({ ws, commands = [], renderTool = null, greeting = null, terminal = new ProcessTerminal() }) {
  const tui = new TuiAltScreen(terminal)
  const conversation = new Conversation({ renderTool })
  const status = new StatusLine()
  const editor = new PromptEditor(tui, editorTheme)
  const view = new ScrollView(conversation, { follow: 'end', primary: true })
  tui.setLayoutRoot(new VStack([
    { component: view, basis: 0, grow: 1, minSize: 1 },
    { component: editor, basis: 'auto', shrink: 1, minSize: 3 },
    { component: status, basis: 'auto' }
  ]))
  const allCommands = [...COMMANDS, ...commands]
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(allCommands.map(({ name, description, argumentHint }) => ({ name, description, argumentHint })), process.cwd()))
  tui.setFocus(editor)

  const following = new AbortController()
  const state = { ws: null, grant: null, limits: null, shown: null, attention: new Map(), lastSeq: 0, overlay: null, pressed: {} }
  let finish

  const notice = (text) => {
    status.notice = text
    clearTimeout(state.noticeTimer)
    state.noticeTimer = setTimeout(() => { status.notice = ''; tui.requestRender() }, Math.max(NOTICE_MS, text.length * 60))
    tui.requestRender()
  }
  const notify = (text) => terminal.write(`\x1b]9;${printable(text).replace(/\n/g, ' ')}\x07`)

  const refresh = () => {
    const now = stateOf(state.ws)
    if (now.state !== RUNNING) state.limits = null
    else if (!state.limits) state.limits = show({ ws: state.ws }).turnLimits
    state.shown = { ws: state.ws, model: state.grant.model, billing: state.grant.billing, ...now, turnLimits: state.limits }
    const live = conversation.live ?? createLive()
    const at = Date.now()
    editor.label = sporeLabel({ shown: state.shown, paused: Boolean(paused()), now: at })
    status.parts = statusParts({ shown: state.shown, live, attention: [...state.attention.values()], now: at })
    tui.requestRender()
  }

  const reload = () => {
    conversation.items = history({ turns: readTurns(state.ws), inbox: readInbox(state.ws) })
    conversation.live = null
    state.limits = null
    const running = liveIn(state.ws)
    if (running) {
      state.lastSeq = running.seq
      conversation.live = running.live
    }
    conversation.invalidate()
    refresh()
  }

  const open = (ws) => {
    state.ws = ws
    state.attention.delete(ws)
    state.grant = grantOf(ws)
    state.lastSeq = 0
    remember(ws)
    reload()
    view.scrollToEnd()
  }

  const closeOverlay = () => {
    state.overlay?.hide()
    state.overlay = null
    tui.setFocus(editor)
    tui.requestRender()
  }

  const overlay = (component) => {
    closeOverlay()
    state.overlay = tui.showOverlay(component, { width: '80%', maxHeight: '70%' })
  }

  const picker = () => {
    const now = Date.now()
    const rows = list().workspaces
    overlay(new Picker({
      items: rows.map(row => ({
        value: row.ws,
        label: `${state.attention.has(row.ws) ? '● ' : ''}${basename(row.ws)}`,
        description: `${row.state} · ${row.lastTurnNo} turns · $${row.treeUsd.toFixed(4)} · ${ago(row.last?.endedAt, now)}`
      })),
      onSelect: (item) => { closeOverlay(); open(item.value) },
      onCancel: closeOverlay
    }))
  }

  const statusPanel = () => {
    const shown = show({ ws: state.ws })
    const waiting = outbox(state.ws, { state: 'pending' })
    const refused = outbox(state.ws, { state: 'refused' }).slice(-3)
    const sections = [
      ['workspace', [state.ws]],
      ['works in', shown.writes.map(w => `${w.name}/ → ${w.path}`)],
      ['jobs', shown.jobs.running.map(runningJob)],
      ['schedules', shown.schedules.map(scheduleLine)],
      ['held', shown.held.map(h => `${h.origin}: until ${h.releaseAt}${h.summary ? ` — ${h.summary}` : ''}`)],
      ['waiting to be delivered', waiting.map(e => `${e.recipient} · since ${e.at}`)],
      ['refused', refused.map(e => `${e.recipient} · ${e.settledAt} — ${e.reason}`)],
      ['docs that differ', shown.differs.length ? [`${shown.differs.join(', ')} — spore upgrade ${basename(state.ws)}`] : []]
    ].filter(([, rows]) => rows.length)
    overlay(new Panel(`${basename(state.ws)} · ${shown.model}`,
      sections.map(([title, rows]) => `${title}\n${rows.map(row => `  ${row}`).join('\n')}`).join('\n\n'), closeOverlay))
  }

  const helpPanel = () => overlay(new Panel('keys and commands', [
    'enter send · alt+enter new line · ↑↓ earlier messages · tab complete',
    'ctrl+p open another spore · ctrl+o show tool calls in full · ctrl+g write in $EDITOR · alt+c copy the last code block',
    'esc twice stop the running turn, or clear the line when none runs · ctrl+c clear · ctrl+d on an empty line leave',
    '',
    ...allCommands.map(c => `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''} — ${c.description}`)
  ].join('\n'), closeOverlay))

  const leave = () => {
    following.abort()
    clearInterval(ticking)
    tui.stop({ preserveScreen: true })
    finish(0)
  }

  const copy = async (text, what) => {
    if (await tui.copyTextToClipboard(text)) notice(`copied ${what}`)
  }

  const say = (text) => {
    let sent
    try {
      sent = send(state.ws, text, { replyTo: 'terminal' })
    } catch (err) {
      return notice(err.detail ? `${err.message} — ${err.detail}` : err.message)
    }
    editor.addToHistory(text)
    notice(sent.started ? 'started a turn' : 'heard — the running turn reads it next')
    reload()
    view.scrollToEnd()
  }

  const change = (act) => {
    try {
      notice(changeText(act()))
      state.limits = show({ ws: state.ws }).turnLimits
      refresh()
    } catch (err) {
      notice(err.detail ? `${err.message} — ${err.detail}` : err.message)
    }
  }

  const run = async ({ name, args }) => {
    if (name === 'stop') return notice(stop(state.ws).stopped ? 'stopping it' : 'nothing is running')
    if (name === 'wrap') return change(() => wrapTurn(state.ws, args[0]))
    if (name === 'extend') {
      if (args.length < 2) return notice('/extend wall 30m, /extend cost 1.50 or /extend rounds 20')
      return change(() => extendTurn(state.ws, args[0], args[1]))
    }
    if (name === 'model') {
      const switchTo = (model) => {
        try {
          const switched = switchModel({ ws: state.ws, model })
          notice(switched.was === switched.model ? `already runs on ${switched.model}` : `runs on ${switched.model} from the next turn`)
          refresh()
        } catch (err) {
          notice(err.detail ? `${err.message} — ${err.detail}` : err.message)
        }
      }
      if (args.length) return switchTo(args[0])
      const { model, models } = show({ ws: state.ws })
      if (!models.length) return notice(`runs on ${model} — add models: to its spore.cmk to offer others`)
      return overlay(new Picker({
        items: [model, ...models].map(one => ({ value: one, label: one, description: one === model ? 'now' : '' })),
        onSelect: (item) => { closeOverlay(); switchTo(item.value) },
        onCancel: closeOverlay
      }))
    }
    if (name === 'curate') {
      const provider = args[0] ?? show({ ws: state.ws }).model.split('/')[0]
      loadMohdelEnvironment()
      notice(`reading what ${provider} lists…`)
      let listed
      try {
        listed = await upstream(provider)
      } catch (err) {
        return notice(err.message)
      }
      if (listed === null) return notice(`mohdel cannot list ${provider}'s models — without its key, mo onboard ${provider} sets it`)
      if (!listed.length) return notice(`${provider} lists nothing your catalog does not already hold or exclude`)
      const add = async (id) => {
        try {
          const [added] = await curate(provider, [id])
          notice(`${added.model} is in your catalog${added.priced === false ? ', without prices: its calls count as $0' : ''} — ` +
            `spore edit adds it to a spore's models:, spore config set model ${added.model} makes new spores run on it`)
        } catch (err) {
          notice(err.message)
        }
      }
      return overlay(new Picker({
        title: `a ${provider} model for your catalog`,
        header: [`${listed.length} not in it yet — mohdel's catalog, shared with mo and every spore`],
        items: listed.map(one => ({ value: one.id, label: one.id, description: priceText(one) })),
        onSelect: (item) => { closeOverlay(); add(item.value) },
        onCancel: closeOverlay
      }))
    }
    if (name === 'pause') {
      const done = pause({ why: args.join(' ') || undefined })
      return notice(`paused${done.turns.length ? ` — stopped ${done.turns.length} turn${done.turns.length > 1 ? 's' : ''}` : ''}`)
    }
    if (name === 'unpause') return notice(unpause().unpaused ? 'turns start again' : 'it was not paused')
    if (name === 'spores') return picker()
    if (name === 'status') return statusPanel()
    if (name === 'help') return helpPanel()
    if (name === 'quit') return leave()
    if (name === 'copy') {
      if (!args.length) {
        const answer = conversation.live?.complete?.output ?? conversation.lastAnswer()?.text
        if (!answer) return notice('no answer to copy yet')
        return copy(answer, 'the last answer')
      }
      const blocks = conversation.lastBlocks()
      const n = Number(args[0])
      if (!blocks.length) return notice('the last answer has no code block')
      if (!Number.isInteger(n) || n < 1 || n > blocks.length) return notice(`the last answer has ${blocks.length === 1 ? '1 code block — /copy 1' : `${blocks.length} code blocks — /copy 1 to /copy ${blocks.length}`}`)
      return copy(blocks[n - 1].text, `code block ${n}`)
    }
    const added = commands.find(c => c.name === name)
    if (!added) return notice(`no /${name} — /help lists them`)
    try {
      await added.run(args, { ws: state.ws, notice, send: say, outside, confirm, running: () => state.shown?.state === RUNNING })
    } catch (err) {
      notice(err.message)
    }
  }

  editor.onSubmit = (text) => {
    const trimmed = text.trim()
    if (!trimmed) return
    editor.setText('')
    const command = parseCommand(trimmed)
    if (command) return run(command)
    say(trimmed.startsWith('//') ? trimmed.slice(1) : trimmed)
  }

  const twice = (key, first, then) => {
    const now = Date.now()
    if (now - (state.pressed[key] ?? 0) < TWICE_MS) {
      state.pressed[key] = 0
      return then()
    }
    state.pressed[key] = now
    notice(first)
  }

  const outside = (fn) => {
    tui.stop({ preserveScreen: true })
    try {
      return fn()
    } finally {
      tui.start()
      tui.requestRender(true)
    }
  }

  const confirm = (title, text, confirming) => new Promise(resolve => {
    overlay(new Panel(title, text, () => { closeOverlay(); resolve(false) }, { confirming, onConfirm: () => { closeOverlay(); resolve(true) } }))
  })

  const compose = () => {
    const directory = mkdtempSync(join(tmpdir(), 'spore-tui-'))
    const file = join(directory, 'message.md')
    writeFileSync(file, editor.getText())
    const [command, ...flags] = (process.env.VISUAL || process.env.EDITOR || 'vi').split(' ')
    const done = outside(() => spawnSync(command, [...flags, file], { stdio: 'inherit' }))
    if (done.status === 0) editor.setText(readFileSync(file, 'utf8').replace(/\n$/, ''))
    else notice(`${command} did not finish — the message is as it was`)
    rmSync(directory, { recursive: true, force: true })
  }

  tui.addInputListener((data) => {
    if (isKeyRelease(data)) return undefined
    if (matchesKey(data, 'ctrl+c')) {
      if (state.overlay) {
        closeOverlay()
        return { consume: true }
      }
      if (editor.getText()) {
        editor.setText('')
        tui.requestRender()
        return { consume: true }
      }
      notice('ctrl+d to leave')
      return { consume: true }
    }
    if (state.overlay) return undefined
    if (matchesKey(data, 'ctrl+d') && !editor.getText()) {
      leave()
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+p')) { picker(); return { consume: true } }
    if (matchesKey(data, 'alt+c')) {
      const block = conversation.lastBlocks().at(-1)
      if (block) copy(block.text, 'the last code block')
      else notice('the last answer has no code block')
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+o')) { conversation.expanded = !conversation.expanded; tui.requestRender(); return { consume: true } }
    if (matchesKey(data, 'ctrl+g')) { compose(); return { consume: true } }
    if (matchesKey(data, 'escape') && !editor.isShowingAutocomplete()) {
      if (state.shown?.state === RUNNING) {
        twice('escape', editor.getText() ? 'esc again to stop the turn — ctrl+c clears the line' : 'esc again to stop the turn', () => notice(stop(state.ws).stopped ? 'stopping it' : 'nothing is running'))
        return { consume: true }
      }
      if (!editor.getText()) return undefined
      twice('escape', 'esc again to clear', () => { editor.setText(''); tui.requestRender() })
      return { consume: true }
    }
    return undefined
  })

  const follow = async () => {
    for await (const item of watchAll(() => list().workspaces.map(row => row.ws), { signal: following.signal })) {
      if (item.ws === state.ws) {
        if (item.event) {
          if (item.event.seq <= state.lastSeq) continue
          state.lastSeq = item.event.seq
          const live = conversation.live ?? createLive()
          if (applyEvent(live, item.event)) {
            conversation.live = live
            tui.requestRender()
          }
          continue
        }
        const { startedAt, endedAt } = item.turn.record
        if (Date.parse(endedAt) - Date.parse(startedAt) > LONG_TURN_MS) notify(`${basename(item.ws)}: ${item.turn.record.stopReason}`)
        reload()
        continue
      }
      if (!item.turn) continue
      const asked = item.turn.record.stopReason === 'question'
      state.attention.set(item.ws, { name: basename(item.ws), asked })
      notify(`${basename(item.ws)} ${asked ? 'asked' : 'answered'}`)
      refresh()
    }
  }

  open(ws)
  if (greeting) notice(greeting)
  tui.start()
  const ticking = setInterval(refresh, REFRESH_MS)
  follow().catch(err => notice(`stopped following the spores — ${err.message}`))
  return new Promise(resolve => { finish = resolve })
}
