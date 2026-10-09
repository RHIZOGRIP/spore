import { describe, it, expect } from 'vitest'

import { printable } from '../tui/printable.js'

describe('text put on the terminal', () => {
  it('keeps prose, its newlines, and what is not ASCII', () => {
    expect(printable('Fixed #56 — see the PR.\nNext: #22 · café')).toBe('Fixed #56 — see the PR.\nNext: #22 · café')
  })

  it('drops the escape that would write the clipboard or clear the screen', () => {
    const shown = printable('done\x1b]52;c;cm0gLXJmIH4=\x07\x1b[2J\x1b[H')
    expect([...shown].some(c => c.charCodeAt(0) < 0x20)).toBe(false)
    expect(shown.startsWith('done')).toBe(true)
  })

  it('drops C1 controls and DEL', () => {
    expect(printable('a\x9b2Jb\x7fc')).toBe('a2Jbc')
  })

  it('drops what would show text in another order than it reads', () => {
    expect(printable('access ‮resu‬ granted ⁧x⁩')).toBe('access resu granted x')
  })

  it('turns a tab into spaces', () => {
    expect(printable('a\tb')).toBe('a  b')
  })
})
