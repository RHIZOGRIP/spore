import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SPORE_ROOT = dirname(__dirname)
const SANDBOX_MODULE = resolve(SPORE_ROOT, 'src/isolation/sandbox.js')
const WS = resolve(SPORE_ROOT, 'test/.workspace')
const { landlockAbi } = await import('../src/isolation/sandbox.js')
const { runShell } = await import('../src/core/command.js')
const ABI = landlockAbi()

/**
 * Run a JS snippet in a child process with the sandbox applied.
 * The snippet has `sandbox`, `WS`, `SPORE_ROOT` available.
 * Returns { status, stdout, stderr }.
 */
function run (code, { applySandbox = true, sandboxCall = 'sandbox(WS)' } = {}) {
  const script = `
    import { sandbox } from '${SANDBOX_MODULE}';
    const WS = '${WS}';
    const SPORE_ROOT = '${SPORE_ROOT}';
    ${applySandbox ? sandboxCall + ';' : ''}
    ${code}
  `
  try {
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return { status: 0, stdout, stderr: '' }
  } catch (e) {
    return { status: e.status, stdout: e.stdout || '', stderr: e.stderr || '' }
  }
}

describe('confinement that was asked for and did not happen', () => {
  it('stops rather than warning, so nothing above it believes it is sandboxed', async () => {
    const { sandbox } = await import('../src/isolation/sandbox.js')
    // A workspace it cannot prepare, which is the same commitment as a ruleset it
    // cannot install: an old kernel, a blocked syscall, a rule that will not take.
    // It used to log a warning, return -1, and let the caller carry on unconfined.
    expect(() => sandbox('/proc/self/not-a-workspace', { writeDir: 'data' }))
      .toThrow(expect.objectContaining({ type: 'SANDBOX_FAILED' }))
  })

  it('reads the kernel\'s Landlock ABI', async () => {
    const { landlockAbi } = await import('../src/isolation/sandbox.js')
    expect(landlockAbi()).toBeGreaterThan(0)
  })

  it('grants no read of the user config directory', async () => {
    const { systemReadPaths } = await import('../src/isolation/sandbox.js')
    expect(systemReadPaths().some(p => p.endsWith('/.config'))).toBe(false)
  })
})

describe(`signals, within a sandbox and its own ${ABI >= 6 ? '' : '(skipped: needs Linux 6.12, Landlock 6) '}`, () => {
  it.skipIf(ABI < 6)('cannot signal a process outside its sandbox, and can signal one it started', () => {
    mkdirSync(WS, { recursive: true })
    const outside = spawn('sleep', ['30'])
    try {
      const { stdout, stderr } = run(`
        import { spawn } from 'node:child_process';
        try { process.kill(${outside.pid}, 0); console.log('reached the outside') } catch (e) { console.log(e.code) }
        const own = spawn('sleep', ['5']);
        process.kill(own.pid, 'SIGTERM');
        console.log('stopped its own');
      `)
      expect(stdout, stderr).toMatch(/EPERM/)
      expect(stdout).toMatch(/stopped its own/)
    } finally {
      outside.kill()
    }
  })

  it.skipIf(ABI < 6)('leaves exec to signal what the agent can, and scopes a job\'s command to itself', async () => {
    mkdirSync(WS, { recursive: true })
    const outside = spawn('sleep', ['30'])
    const shell = (scopeSignals) => runShell({
      command: `kill -0 ${outside.pid}`,
      cwd: WS,
      outAbs: resolve(WS, 'kill.out'),
      errAbs: resolve(WS, 'kill.err'),
      confine: { writeRoot: WS, reads: [], scopeSignals },
      env: process.env
    })
    try {
      expect((await shell(false)).exit).toBe(0)
      expect((await shell(true)).exit).not.toBe(0)
    } finally {
      outside.kill()
    }
  })
})

describe('landlock sandbox', () => {
  beforeAll(() => {
    mkdirSync(WS, { recursive: true })
    writeFileSync(resolve(WS, 'hello.txt'), 'hello from workspace')
  })

  afterAll(() => {
    rmSync(WS, { recursive: true, force: true })
  })

  // ── Verify sandbox activates ──────────────────────────────────────

  it('reports landlock version on stderr', () => {
    run(`
      import { writeFileSync } from 'node:fs';
      writeFileSync('/dev/stderr', '');
    `)
    // sandbox message may go to inherited stderr; verify sandbox is active
    // by confirming confinement works (write to home fails)
    const { status: s2 } = run(`
      import { writeFileSync } from 'node:fs';
      writeFileSync(process.env.HOME + '/.spore-test-active', 'x');
    `)
    expect(s2).not.toBe(0)
  })

  // ── Filesystem: workspace access ──────────────────────────────────

  it('can read files inside workspace', () => {
    const { status, stdout } = run(`
      import { readFileSync } from 'node:fs';
      console.log(readFileSync(WS + '/hello.txt', 'utf8'));
    `)
    expect(status).toBe(0)
    expect(stdout.trim()).toBe('hello from workspace')
  })

  it('can write files inside workspace', () => {
    const { status } = run(`
      import { writeFileSync } from 'node:fs';
      writeFileSync(WS + '/written.txt', 'ok');
    `)
    expect(status).toBe(0)
    expect(readFileSync(resolve(WS, 'written.txt'), 'utf8')).toBe('ok')
  })

  it('can create directories inside workspace', () => {
    const { status } = run(`
      import { mkdirSync, writeFileSync } from 'node:fs';
      mkdirSync(WS + '/sub/dir', { recursive: true });
      writeFileSync(WS + '/sub/dir/file.txt', 'nested');
    `)
    expect(status).toBe(0)
    expect(readFileSync(resolve(WS, 'sub/dir/file.txt'), 'utf8')).toBe('nested')
  })

  // ── Filesystem: blocked outside workspace ─────────────────────────

  it('cannot write to /tmp, which every other spore of the account would reach too', () => {
    const { status, stderr } = run(`
      import { writeFileSync } from 'node:fs';
      writeFileSync('/tmp/spore-test-escape-' + process.pid, 'pwned');
    `)
    expect(status).not.toBe(0)
    expect(stderr).toMatch(/EACCES|EPERM|Permission denied/)
  })

  it('writes the one directory outside it that it is given, its socket directory', () => {
    const given = resolve(SPORE_ROOT, 'test/.workspace-sockets')
    mkdirSync(given, { recursive: true })
    try {
      const { status, stderr } = run(`
        import { writeFileSync } from 'node:fs';
        writeFileSync('${given}/bound', 'ok');
      `, { sandboxCall: `sandbox(WS, { extraWritePaths: ['${given}'] })` })
      expect(status, stderr).toBe(0)
      expect(readFileSync(resolve(given, 'bound'), 'utf8')).toBe('ok')
    } finally {
      rmSync(given, { recursive: true, force: true })
    }
  })

  it('cannot write to home directory', () => {
    const { status: s2, stderr: err2 } = run(`
      import { writeFileSync } from 'node:fs';
      writeFileSync(process.env.HOME + '/.spore-sandbox-test', 'pwned');
    `)
    expect(s2).not.toBe(0)
    expect(err2).toMatch(/EACCES|EPERM|EROFS|Permission denied/)
  })

  it('cannot read files outside allowed paths', () => {
    const { status, stderr } = run(`
      import { readFileSync } from 'node:fs';
      readFileSync(process.env.HOME + '/.bashrc', 'utf8');
    `)
    expect(status).not.toBe(0)
    expect(stderr).toMatch(/EACCES|EPERM|Permission denied/)
  })

  // ── Filesystem: read-only system paths ────────────────────────────

  it('can read system files (read-only)', () => {
    const { status, stdout } = run(`
      import { readFileSync } from 'node:fs';
      const data = readFileSync('/etc/hostname', 'utf8');
      console.log(data.length > 0 ? 'ok' : 'empty');
    `)
    expect(status).toBe(0)
    expect(stdout.trim()).toBe('ok')
  })

  it('cannot write to system paths', () => {
    const { status, stderr } = run(`
      import { writeFileSync } from 'node:fs';
      writeFileSync('/etc/spore-test', 'pwned');
    `)
    expect(status).not.toBe(0)
    expect(stderr).toMatch(/EACCES|EROFS|Permission denied/)
  })

  // ── Child processes inherit sandbox ───────────────────────────────

  it('exec inherits sandbox — can run commands in workspace', () => {
    const { status, stdout } = run(`
      import { execSync } from 'node:child_process';
      const out = execSync('cat ' + WS + '/hello.txt', { encoding: 'utf8' });
      console.log(out);
    `)
    expect(status).toBe(0)
    expect(stdout.trim()).toBe('hello from workspace')
  })

  it('exec inherits sandbox — cannot write outside workspace', () => {
    const { status, stderr } = run(`
      import { execSync } from 'node:child_process';
      execSync('touch ' + process.env.HOME + '/.spore-sandbox-exec-' + process.pid);
    `)
    expect(status).not.toBe(0)
    expect(stderr).toMatch(/Permission denied|EACCES|EPERM/)
  })

  // ── Split root (writeDir) ─────────────────────────────────────────

  const splitRoot = { sandboxCall: "sandbox(WS, { writeDir: 'out' })" }

  it('split root: workspace stays readable', () => {
    const { status, stdout } = run(`
      import { readFileSync } from 'node:fs';
      console.log(readFileSync(WS + '/hello.txt', 'utf8'));
    `, splitRoot)
    expect(status).toBe(0)
    expect(stdout.trim()).toBe('hello from workspace')
  })

  it('split root: workspace is not writable', () => {
    const { status, stderr } = run(`
      import { writeFileSync } from 'node:fs';
      writeFileSync(WS + '/blocked.txt', 'x');
    `, splitRoot)
    expect(status).not.toBe(0)
    expect(stderr).toMatch(/EACCES|EPERM|EROFS|Permission denied/)
  })

  it('split root: only the writeDir is writable', () => {
    const { status } = run(`
      import { writeFileSync } from 'node:fs';
      writeFileSync(WS + '/out/allowed.txt', 'ok');
    `, splitRoot)
    expect(status).toBe(0)
    expect(readFileSync(resolve(WS, 'out/allowed.txt'), 'utf8')).toBe('ok')
  })

  it('split root: exec inherits the same split', () => {
    const { status, stderr } = run(`
      import { execSync } from 'node:child_process';
      execSync('cat ' + WS + '/hello.txt > ' + WS + '/out/copied.txt');
      execSync('cat ' + WS + '/hello.txt > ' + WS + '/denied.txt');
    `, splitRoot)
    expect(status).not.toBe(0)
    expect(stderr).toMatch(/Permission denied|EACCES|EPERM/)
    expect(readFileSync(resolve(WS, 'out/copied.txt'), 'utf8').trim()).toBe('hello from workspace')
  })

  it('split root: a writeDir outside the workspace is refused, not silently widened', () => {
    const { status, stderr } = run(`
      console.log('reached');
    `, { sandboxCall: "sandbox(WS, { writeDir: '../escape' })" })
    expect(status).not.toBe(0)
    expect(stderr).toMatch(/escapes workspace|PATH_ESCAPE/)
  })

  // ── Network ───────────────────────────────────────────────────────

  it('cannot bind a TCP server', () => {
    const { status, stderr } = run(`
      import { createServer } from 'node:net';
      const srv = createServer();
      srv.listen(0, () => { srv.close(); process.exit(0) });
      srv.on('error', (e) => { console.error(e.code); process.exit(1) });
    `)
    expect(status).not.toBe(0)
    expect(stderr).toMatch(/EACCES|EPERM/)
  })

  // ── Graceful degradation ──────────────────────────────────────────

  it('without sandbox, can write anywhere', () => {
    const target = '/tmp/spore-test-no-sandbox-' + Date.now()
    const { status } = run(`
      import { writeFileSync, unlinkSync } from 'node:fs';
      writeFileSync('${target}', 'ok');
      unlinkSync('${target}');
    `, { applySandbox: false })
    expect(status).toBe(0)
  })
})
