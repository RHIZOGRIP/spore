import { describe, it, expect } from 'vitest'

import { exitText } from '../src/core/command.js'
import { bytesText, durationSpelling, durationText, limitText, sizeSpelling } from '../src/core/units.js'

describe('amounts as text', () => {
  it('rounds a measured one for reading', () => {
    expect([512, 2048, 1536 * 1024, 3 * 1024 ** 3].map(bytesText)).toEqual(['512B', '2.0KB', '1.5MB', '3.0GB'])
    expect([4_000, 125_000, 3_600_000, 5_400_000].map(durationText)).toEqual(['4s', '2m', '1h', '1.5h'])
  })

  it('reads a turn\'s limit the way it reads a measured amount', () => {
    expect([['rounds', 12], ['cost', 0.4123], ['wall', 600_000], ['wall', 5_400_000]].map(([dimension, value]) => limitText(dimension, value)))
      .toEqual(['12 rounds', '$0.41', '10m', '1.5h'])
  })

  it('spells a declared bound as a definition writes it', () => {
    expect([1500, 1024, 512 * 1024 ** 2, 1024 ** 3].map(sizeSpelling)).toEqual(['1500B', '1KB', '512MB', '1GB'])
    expect([45_000, 60_000, 5_400_000, 7_200_000].map(durationSpelling)).toEqual(['45s', '1m', '90m', '2h'])
  })
})

describe('how a program ended', () => {
  it('says its code or signal, how long it ran when known, and the last line it printed on stderr', () => {
    expect(exitText({ exit: 2, signal: null, stderr: 'reading\nno pdf\n' })).toBe('exited 2 — no pdf')
    expect(exitText({ exit: null, signal: 'SIGKILL', took: 180_000 })).toBe('exited SIGKILL after 3m')
  })
})
