#!/usr/bin/env node
/**
 * `$SPORE_MCP` — an MCP client the agent runs, inside its own sandbox, one session per invocation.
 * The servers are `data/mcp.json`; a result goes to a file, or to stdout with `--out -`, never into
 * the conversation, and the exit code is the only success signal.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import minimist from 'minimist'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'

const SERVERS = 'data/mcp.json'
const USAGE = `mcp — call the tools of an MCP server

  "$SPORE_MCP" --list                                   the servers in ${SERVERS}
  "$SPORE_MCP" <server> --tools                         each tool's name and first line
  "$SPORE_MCP" <server> --describe <tool>               its input schema, as JSON
  "$SPORE_MCP" <server> <tool> [--args <file.json>] --out <file|->
  "$SPORE_MCP" <server> --calls <file.jsonl> --out-dir <dir>

  --out -      the result on stdout, for exec, whose stdout the call's out already holds
  --timeout N  seconds a request may take (60)

${SERVERS} names each server: { "<name>": { "command": "…", "args": [ … ] } } for a local one
over stdio, { "<name>": { "url": "https://…" } } for a remote one. No secret goes in it.`

const argv = minimist(process.argv.slice(2), { string: ['args', 'out', 'describe', 'calls', 'out-dir'], boolean: ['list', 'tools', 'help'] })
const [server, tool] = argv._.map(String)

const usage = (problem) => {
  console.error(`mcp: ${problem}\n\n${USAGE}`)
  process.exit(2)
}
const fail = (problem) => {
  console.error(`mcp: ${problem}`)
  process.exit(1)
}

if (argv.help) {
  console.log(USAGE)
  process.exit(0)
}

function servers () {
  let raw
  try {
    raw = readFileSync(SERVERS, 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    usage(`no ${SERVERS} — write one naming the servers this spore may call`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    usage(`${SERVERS} is not readable JSON — ${err.message}`)
  }
  for (const [name, entry] of Object.entries(parsed)) {
    const local = typeof entry?.command === 'string'
    const remote = typeof entry?.url === 'string'
    if (local === remote) usage(`${SERVERS} has a server ${name} with neither a command nor a url, or both`)
  }
  return parsed
}

if (argv.list) {
  for (const [name, entry] of Object.entries(servers())) {
    console.log(`${name.padEnd(16)} ${entry.url ?? [entry.command, ...(entry.args ?? [])].join(' ')}`)
  }
  process.exit(0)
}

if (!server) usage('which server?')
const entry = servers()[server]
if (!entry) usage(`no server called ${server} in ${SERVERS} — "$SPORE_MCP" --list shows them`)
const timeout = Number(argv.timeout ?? 60) * 1000
if (!(timeout > 0)) usage('--timeout is a number of seconds')

const stderrOfServer = []
function transport () {
  if (entry.url) return new StreamableHTTPClientTransport(new URL(entry.url))
  const local = new StdioClientTransport({
    command: entry.command,
    args: entry.args ?? [],
    env: { ...getDefaultEnvironment(), ...entry.env },
    cwd: entry.cwd ? resolve(entry.cwd) : process.cwd(),
    stderr: 'pipe'
  })
  local.stderr?.on('data', chunk => stderrOfServer.push(chunk))
  return local
}

const client = new Client({ name: 'spore-mcp', version: '0.1.0' })
const said = () => {
  const text = Buffer.concat(stderrOfServer).toString('utf8').trim()
  return text ? ` — it said: ${text.split('\n').slice(-5).join(' | ')}` : ''
}

try {
  await client.connect(transport())
} catch (err) {
  fail(`${server} did not start or answer — ${err.message}${said()}`)
}

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'application/pdf': 'pdf' }

function mapped (result) {
  const text = []
  const files = []
  for (const part of result.content ?? []) {
    if (part.type === 'text') text.push(part.text)
    else if (part.type === 'image' || part.type === 'audio') files.push({ bytes: Buffer.from(part.data, 'base64'), ext: EXTENSIONS[part.mimeType] ?? 'bin' })
    else if (part.type === 'resource' && part.resource.text !== undefined) files.push({ bytes: Buffer.from(part.resource.text, 'utf8'), ext: 'txt' })
    else if (part.type === 'resource') files.push({ bytes: Buffer.from(part.resource.blob, 'base64'), ext: EXTENSIONS[part.resource.mimeType] ?? 'bin' })
    else if (part.type === 'resource_link') text.push(`link: ${part.uri}${part.name ? ` (${part.name})` : ''}`)
  }
  const body = !result.isError && result.structuredContent !== undefined
    ? JSON.stringify(result.structuredContent, null, 2) + '\n'
    : text.join('\n') + (text.length ? '\n' : '')
  return { body, files }
}

async function call (name, args, out) {
  let result
  try {
    result = await client.callTool({ name, arguments: args }, { timeout })
  } catch (err) {
    return { line: { server, tool: name, ok: false, out, error: err.message }, ok: false }
  }
  const { body, files } = mapped(result)
  const ok = !result.isError
  if (out === '-') {
    process.stdout.write(body)
    if (files.length) return { line: { server, tool: name, ok: false, out, error: `the result has ${files.length} part(s) that are not text, which stdout cannot hold — call it under wsexec with --out <file>` }, ok: false }
    return { line: { server, tool: name, ok, out, bytes: Buffer.byteLength(body) }, ok }
  }
  writeFileSync(out, body)
  const written = files.map(({ bytes, ext }, i) => {
    const path = `${out}.${i + 1}.${ext}`
    writeFileSync(path, bytes)
    return path
  })
  return { line: { server, tool: name, ok, out, bytes: Buffer.byteLength(body), files: written }, ok }
}

async function tools () {
  const found = []
  let cursor
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { timeout })
    found.push(...page.tools)
    cursor = page.nextCursor
  } while (cursor)
  return found
}

let code = 0
try {
  if (argv.tools) {
    for (const each of await tools()) console.log(`${each.name.padEnd(24)} ${(each.description ?? '').split('\n')[0]}`)
  } else if (argv.describe) {
    const found = (await tools()).find(each => each.name === argv.describe)
    if (!found) fail(`${server} has no tool ${argv.describe} — "$SPORE_MCP" ${server} --tools lists them`)
    console.log(JSON.stringify({ name: found.name, description: found.description, inputSchema: found.inputSchema, outputSchema: found.outputSchema }, null, 2))
  } else if (argv.calls) {
    if (!argv['out-dir']) usage('--calls writes each result under --out-dir <dir>')
    const lines = readFileSync(argv.calls, 'utf8').split('\n').filter(line => line.trim())
    for (const [i, raw] of lines.entries()) {
      let each
      try {
        each = JSON.parse(raw)
      } catch (err) {
        fail(`line ${i + 1} of ${argv.calls} is not JSON — ${err.message}`)
      }
      if (typeof each.tool !== 'string' || typeof each.out !== 'string') fail(`line ${i + 1} of ${argv.calls} needs a tool and an out, as { "tool", "args", "out" }`)
      const { line, ok } = await call(each.tool, each.args ?? {}, join(argv['out-dir'], each.out))
      console.log(JSON.stringify(line))
      if (!ok) code = 1
    }
  } else {
    if (!tool) usage(`what to do with ${server}? --tools, --describe <tool>, or a tool to call`)
    if (!argv.out) usage('a call writes its result to --out <file>, or to stdout with --out -')
    let args = {}
    if (argv.args) {
      try {
        args = JSON.parse(readFileSync(argv.args, 'utf8'))
      } catch (err) {
        usage(`--args ${argv.args} is not a readable JSON file — ${err.message}`)
      }
    }
    const { line, ok } = await call(tool, args, argv.out)
    const summary = JSON.stringify(line)
    if (argv.out === '-') console.error(summary)
    else console.log(summary)
    if (!ok) code = 1
  }
} catch (err) {
  console.error(`mcp: ${server} — ${err.message}${said()}`)
  code = 1
} finally {
  await client.close()
}
process.exit(code)
