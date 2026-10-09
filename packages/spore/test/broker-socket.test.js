import { describe, it, expect } from 'vitest'
import { existsSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'

import { brokerSocketPath } from '../src/infra/broker-socket.js'

// AF_UNIX carries its path in a 108-byte field. The runtime points TMPDIR at a scratch
// directory inside the workspace for every command an agent runs, so a broker started by
// one of those — `bin/spawn.js`, hosting the enzyme broker for a cell — built its socket
// under `<ws>/calls/<run>/<seq>/scratch/` and a workspace a few directories deep went
// past the limit. Measured at 131 bytes: "AF_UNIX path too long". Every cell in the
// fan-out died before writing a frame, and the helper reported `stopReason: null`.
describe('where a broker socket goes', () => {
  it('roots at /tmp whatever TMPDIR says', () => {
    const deep = `/home/someone/a/rather/long/path/${'nested/'.repeat(8)}scratch`
    const before = process.env.TMPDIR
    process.env.TMPDIR = deep
    try {
      expect(brokerSocketPath('enzymes').startsWith(`/tmp/spore-${userInfo().uid}/`)).toBe(true)
    } finally {
      if (before === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = before
    }
  })

  it('stays inside the unix socket path limit', () => {
    for (const kind of ['model', 'enzymes']) {
      expect(brokerSocketPath(kind).length).toBeLessThanOrEqual(107)
    }
  })

  it('keeps a directory of its own per user, closed to the others', () => {
    brokerSocketPath('model')
    const root = `/tmp/spore-${userInfo().uid}`
    expect(existsSync(root)).toBe(true)
    expect(statSync(root).mode & 0o077).toBe(0)
    expect(statSync(root).uid).toBe(userInfo().uid)
  })
})
