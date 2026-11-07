import { beforeAll, describe, expect, it } from 'vitest'
import { getCapabilities, getOsc8LinkAtColumn, setCapabilityOverrides, stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import { Answer } from '../tui/answer.js'
import { copyNumber, copyUrl, deliveredLine, fenceLabel, fileOf } from '../tui/links.js'

const same = (text) => text
const withBorder = (border) => Object.fromEntries([
  'heading', 'link', 'linkUrl', 'code', 'codeBlock', 'quote', 'quoteBorder',
  'hr', 'listBullet', 'bold', 'italic', 'strikethrough', 'underline'
].map(key => [key, same]).concat([['codeBlockBorder', border]]))

const dim = (text) => `\x1b[2m${text}\x1b[22m`

const text = ['Run this:', '', '```sh', 'wpctl inspect 48', '```', '', '```ini', '[Unit]', '```', ''].join('\n')

const rows = (border, labelled) => new Answer(text, withBorder(border), { labelled }).render(100)
const rowOf = (lines, needle) => lines.findIndex(line => stripTerminalSequences(line).includes(needle))
const colOf = (line, needle) => stripTerminalSequences(line).indexOf(needle) + 1

beforeAll(() => setCapabilityOverrides({ ...getCapabilities(), hyperlinks: true }))

describe('the link a labelled code block carries', () => {
  it('names the block its fence numbers', () => {
    expect(copyUrl('```sh · /copy 2')).toBe('spore-copy:2')
    expect(copyUrl('```')).toBe(null)
    expect(copyUrl('```sh')).toBe(null)
  })

  it('is read back as the number to copy, and nothing else is', () => {
    expect(copyNumber(copyUrl('```ini · /copy 3'))).toBe(3)
    expect(copyNumber('https://example.com/2')).toBe(null)
    expect(copyNumber('spore-copy:')).toBe(null)
    expect(copyNumber('spore-copy:0')).toBe(null)
    expect(copyNumber('spore-copy:two')).toBe(null)
  })

  it('is drawn on the label the click lands on, and not on the code around it', () => {
    const lines = rows((label) => fenceLabel(label, dim), true)
    const label = lines[rowOf(lines, '/copy 1')]
    expect(getOsc8LinkAtColumn(label, colOf(label, '/copy'))).toBe('spore-copy:1')
    const second = lines[rowOf(lines, '/copy 2')]
    expect(getOsc8LinkAtColumn(second, colOf(second, '/copy'))).toBe('spore-copy:2')
    const body = lines[rowOf(lines, 'wpctl inspect 48')]
    expect(getOsc8LinkAtColumn(body, 3)).toBe(undefined)
    const closing = lines.find(line => stripTerminalSequences(line).trim() === '```')
    expect(getOsc8LinkAtColumn(closing, 1)).toBe(undefined)
  })

  it('leaves the label reading as before and the line no wider', () => {
    const linked = rows((label) => fenceLabel(label, dim), true)
    const plain = rows(dim, true)
    const row = rowOf(linked, '/copy 1')
    expect(stripTerminalSequences(linked[row])).toBe(stripTerminalSequences(plain[row]))
    expect(visibleWidth(linked[row])).toBe(visibleWidth(plain[row]))
    expect(linked[row]).toContain('\x1b[2m')
  })

  it('is absent when the answer is not labelled, and when the terminal shows no hyperlinks', () => {
    const unlabelled = rows((label) => fenceLabel(label, dim), false)
    expect(unlabelled.some(line => stripTerminalSequences(line).includes('/copy'))).toBe(false)
    expect(unlabelled.some(line => line.includes('\x1b]8;;'))).toBe(false)

    setCapabilityOverrides({ ...getCapabilities(), hyperlinks: false })
    const noLinks = rows((label) => fenceLabel(label, dim), true)
    expect(noLinks[rowOf(noLinks, '/copy 1')]).not.toContain('\x1b]8;;')
    expect(stripTerminalSequences(noLinks[rowOf(noLinks, '/copy 1')])).toContain('```sh · /copy 1')
    setCapabilityOverrides({ ...getCapabilities(), hyperlinks: true })
  })
})

describe('a delivered file', () => {
  const report = { path: '/spores/main/data/out/my report.md', bytes: 3406 }

  it('reads as its full path and its size', () => {
    expect(stripTerminalSequences(deliveredLine(report))).toBe('delivered  /spores/main/data/out/my report.md  3.3KB')
  })

  it('links the path, and a click on it gives the path back', () => {
    const line = deliveredLine(report)
    const url = getOsc8LinkAtColumn(line, colOf(line, 'report'))
    expect(url).toBe('file:///spores/main/data/out/my%20report.md')
    expect(fileOf(url, '/elsewhere')).toBe(report.path)
    expect(getOsc8LinkAtColumn(line, colOf(line, 'delivered'))).toBe(undefined)
    expect(getOsc8LinkAtColumn(line, colOf(line, '3.3KB'))).toBe(undefined)
  })

  it('stays one link when a narrow screen wraps it', () => {
    const wrapped = wrapTextWithAnsi(deliveredLine(report), 24)
    const second = wrapped.findIndex(line => stripTerminalSequences(line).includes('out'))
    expect(second).toBeGreaterThan(0)
    expect(getOsc8LinkAtColumn(wrapped[second], colOf(wrapped[second], 'out'))).toBe('file:///spores/main/data/out/my%20report.md')
  })

  it('puts nothing on the terminal that a file name asked for', () => {
    const line = deliveredLine({ path: '/w/data/out/a\x1b]0;x\x07.md', bytes: 1 })
    expect(stripTerminalSequences(line)).toBe('delivered  /w/data/out/a]0;x.md  1B')
    expect(line).not.toContain('\x07')
    expect(fileOf(getOsc8LinkAtColumn(line, colOf(line, 'a]0')), '/w')).toBe('/w/data/out/a\x1b]0;x\x07.md')
  })

  it('is not linked when the terminal shows no hyperlinks', () => {
    setCapabilityOverrides({ ...getCapabilities(), hyperlinks: false })
    expect(deliveredLine(report)).not.toContain('\x1b]8;;')
    setCapabilityOverrides({ ...getCapabilities(), hyperlinks: true })
  })
})

describe('what a link in an answer points at', () => {
  it('reads a relative link from the workspace', () => {
    expect(fileOf('data/out/brief.md', '/spores/main')).toBe('/spores/main/data/out/brief.md')
    expect(fileOf('data/out/my%20brief.md', '/spores/main')).toBe('/spores/main/data/out/my brief.md')
  })

  it('takes an absolute path or a file URL as it stands', () => {
    expect(fileOf('/etc/hosts', '/spores/main')).toBe('/etc/hosts')
    expect(fileOf('file:///etc/hosts', '/spores/main')).toBe('/etc/hosts')
  })

  it('finds no file in a web address, or in a link that does not parse', () => {
    expect(fileOf('https://example.com/a', '/spores/main')).toBe(null)
    expect(fileOf('mailto:a@example.com', '/spores/main')).toBe(null)
    expect(fileOf('https://', '/spores/main')).toBe(null)
    expect(fileOf('data/out/100%.md', '/spores/main')).toBe(null)
    expect(fileOf('file://server/share/a.md', '/spores/main')).toBe(null)
  })
})
