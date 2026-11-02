#!/usr/bin/env node
import { readdirSync, writeFileSync } from 'node:fs'
import { Socket } from 'node:net'

const asked = process.argv.slice(2)
if (asked.includes('--version')) {
  console.log('Stand-in 1.0')
  process.exit(0)
}
const profile = asked.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length)
writeFileSync(`${profile}/launched.json`, JSON.stringify({ argv: asked, env: process.env, processes: readdirSync('/proc').filter(name => /^\d+$/.test(name)).length }))
if (!asked.includes('--remote-debugging-pipe')) process.exit(0)

const out = new Socket({ fd: 4, readable: false, writable: true })
const say = (message, then) => out.write(JSON.stringify(message) + '\0', then)
let buffered = ''
new Socket({ fd: 3, readable: true, writable: false }).on('data', chunk => {
  buffered += chunk
  let end
  while ((end = buffered.indexOf('\0')) >= 0) {
    const { id, method, params, sessionId } = JSON.parse(buffered.slice(0, end))
    buffered = buffered.slice(end + 1)
    if (method === 'Browser.getVersion') {
      say({ id, result: { product: 'Stand-in/1.0' } })
    } else if (method === 'Browser.close') {
      say({ id, result: {} }, () => process.exit(0))
    } else if (method === 'Page.navigate' && params.url === 'https://crash.invalid/') {
      process.exit(3)
    } else if (method === 'Page.navigate') {
      say({ id, result: { frameId: 'f1' }, ...(sessionId ? { sessionId } : {}) })
      say({ method: 'Page.frameNavigated', params: { url: params.url } })
    } else {
      say({ id, error: { code: -32601, message: `'${method}' wasn't found` } })
    }
  }
})
