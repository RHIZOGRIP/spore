import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, release, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { CONFIG_FILE } from '@rhizogrip/spore'

const SPORE = resolve(import.meta.dirname, '../bin/spore.js')
const TEMPLATE = resolve(import.meta.dirname, '../../../.github/ISSUE_TEMPLATE/host-report.yml')
const VERSION = JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')).version

let home

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'spore-report-home-'))
  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify({ home }))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(CONFIG_FILE, { force: true })
})

const report = () => {
  const ran = spawnSync(process.execPath, [SPORE, 'doctor', '--report', '--json'], { encoding: 'utf8' })
  expect(ran.status, ran.stderr).toBe(0)
  return JSON.parse(ran.stdout)
}

describe('spore doctor --report', () => {
  it('describes this machine and the boundary as tried, and names no home directory', () => {
    const { title, body } = report()
    expect(title).toMatch(new RegExp(`^Host report: .+, ${release().replace(/[.+]/g, '\\$&')}$`))
    expect(body).toContain(`| spore | ${VERSION} |`)
    expect(body).toContain(`| kernel | ${release()} |`)
    expect(body).toMatch(/\*\*Boundary\*\*\n\n- (refused|crossed|untried) — read a file outside what it is granted/)
    expect(body).not.toContain(homedir())
  })

  it('fills the repository\'s issue form with it, and sends nothing itself', () => {
    const { title, body, url } = report()
    const asked = new URL(url)
    expect(`${asked.origin}${asked.pathname}`).toBe('https://github.com/RHIZOGRIP/spore/issues/new')
    expect(asked.searchParams.get('template')).toBe('host-report.yml')
    expect(asked.searchParams.get('title')).toBe(title)
    expect(asked.searchParams.get('report')).toBe(body)
    expect(readFileSync(TEMPLATE, 'utf8')).toMatch(/^ {4}id: report$/m)
  })
})
