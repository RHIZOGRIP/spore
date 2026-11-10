import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { canonical, dataOf, receiptOf, sha256, signature } from '../src/core/interactions.js'
import { readConfig } from '../src/library/config.js'

let dir

const lay = (files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spore-interaction-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the canonical form an interaction is hashed in', () => {
  it('orders keys by UTF-16 code units and writes numbers and strings as RFC 8785 says', () => {
    const keys = Object.fromEntries([['\u20ac', 1], ['\r', 2], ['\ufb33', 3], ['1', 4], ['\ud83d\ude00', 5], ['\u0080', 6], ['\u00f6', 7]])
    expect(canonical(keys)).toBe('{"\\r":2,"1":4,"\u0080":6,"\u00f6":7,"\u20ac":1,"\ud83d\ude00":5,"\ufb33":3}')
    expect(canonical([1e21, 1e-7, 0.000001, 2.0, -0, 1 / 3, 1e23])).toBe('[1e+21,1e-7,0.000001,2,0,0.3333333333333333,1e+23]')
    expect(canonical({ b: [true, null, 'a\u0001"\\/'], a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":[true,null,"a\\u0001\\"\\\\/"]}')
    expect(() => canonical({ n: Number.NaN })).toThrow(/no JSON form/)
  })
})

describe('the data as it is sent', () => {
  it('carries every file in UTF-8 path order, whatever it holds, and hashes the handler with each file but its bytes', () => {
    lay({ 'app/run.js': 'eval(1)', 'changes.json': '[]', 'B.txt': 'b', 'é.txt': 'e' })
    const { files, dataHash } = dataOf(dir, 'review')
    expect(files.map(file => file.path)).toEqual(['B.txt', 'app/run.js', 'changes.json', 'é.txt'])
    expect(files[1]).toEqual({ path: 'app/run.js', bytes: 7, sha256: sha256('eval(1)'), data: Buffer.from('eval(1)').toString('base64') })
    const listed = files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
    expect(dataHash).toBe(sha256(canonical({ handler: 'review', files: listed })))
    expect(dataOf(dir, 'review').dataHash).toBe(dataHash)
    expect(dataOf(dir, 'to-file').dataHash).not.toBe(dataHash)
  })

  it('may be empty', () => {
    expect(dataOf(dir, 'review')).toEqual({ files: [], dataHash: sha256(canonical({ handler: 'review', files: [] })) })
  })
})

describe('the receipt of a submitted outcome', () => {
  it('stands a missing responder as null, and sorts attachments by name as UTF-8 bytes', () => {
    const base = { v: 1, id: 'i', dataHash: 'h', answer: { keep: [1] }, submittedAt: '2028-03-02T09:14:40Z' }
    const attachments = [{ name: 'é.png', sha256: 'b' }, { name: 'Z.png', sha256: 'a' }]
    expect(receiptOf({ ...base, attachments })).toBe(sha256(canonical({
      ...base,
      answer: sha256(canonical(base.answer)),
      attachments: [{ name: 'Z.png', sha256: 'a' }, { name: 'é.png', sha256: 'b' }],
      responder: null
    })))
    expect(receiptOf({ ...base, attachments, responder: { by: 'cron' } })).not.toBe(receiptOf({ ...base, attachments }))
  })
})

describe('a request to a handler at a URL', () => {
  it('is signed over the method, the path and the body', () => {
    const headers = signature('s3cret', 'POST', '/v1/interactions', '{"v":1}', 1_700_000_000_500)
    expect(headers['x-spore-timestamp']).toBe('1700000000')
    const expected = createHmac('sha256', 's3cret').update('1700000000.POST /v1/interactions.{"v":1}').digest('hex')
    expect(headers['x-spore-signature']).toBe(`sha256=${expected}`)
    expect(signature('s3cret', 'GET', '/v1/interactions', '{"v":1}', 1_700_000_000_500)['x-spore-signature']).not.toBe(headers['x-spore-signature'])
  })
})

describe('the interactions key in config.json', () => {
  it('names each handler, with a url and a secret named as a variable or an absolute program, and what it does', () => {
    const file = join(dir, 'config.json')
    const config = (interactions) => {
      writeFileSync(file, JSON.stringify({ interactions }))
      return () => readConfig(file)
    }
    const review = { url: 'https://ask.example/', secret: '${REVIEW_SECRET}', what: 'a person keeps or drops each change' } // eslint-disable-line no-template-curly-in-string
    const toFile = { program: '/usr/local/bin/ask-to-file', what: 'written down, answered later' }
    expect(config({ review, 'to-file': toFile })().interactions).toEqual({ review, 'to-file': toFile })
    expect(config({ review: { ...review, secret: 'plain' } })).toThrow(/secret names a variable/)
    expect(config({ review: { ...review, url: 'ftp://ask.example/' } })).toThrow(/url is an http or https address/)
    expect(config({ review: { ...review, token: 'x' } })).toThrow(/it has token/)
    expect(config({ review: { ...review, program: '/bin/true' } })).toThrow(/a url or a program, one of them/)
    expect(config({ review: { url: review.url, secret: review.secret } })).toThrow(/what is one line/)
    expect(config({ 'to-file': { ...toFile, program: 'ask-to-file' } })).toThrow(/program is an absolute path/)
    expect(config({ '-bad': toFile })).toThrow(/a handler's name is/)
    expect(config({ url: review.url, secret: review.secret })).toThrow(/interaction handler "url"/)
    expect(config([review])).toThrow(/not a map/)
  })
})
