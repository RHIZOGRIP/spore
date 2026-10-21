import { beforeAll, describe, expect, it } from 'vitest'
import { getCapabilities, getOsc8LinkAtColumn, setCapabilityOverrides, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'

import { Answer } from '../tui/answer.js'
import { copyNumber, copyUrl, fenceLabel } from '../tui/links.js'

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
