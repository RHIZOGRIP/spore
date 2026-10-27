/**
 * spore in a Linux vm: always on macOS and Windows, where the core does not install, and by choice
 * on Linux. `vm.json` beside `config.json` names the vm, and then every command but `setup` and
 * `vm` runs in it, through `limactl shell`. Nothing here loads the core, which a machine running
 * spore in a vm may not have.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { constants, homedir } from 'node:os'
import { join } from 'node:path'

import { cancel, isCancel, select } from '@clack/prompts'

// The core's CONFIG_DIR, which this cannot import.
const CONFIG_DIR = process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'spore') : join(homedir(), '.config', 'spore')
const VM_FILE = join(CONFIG_DIR, 'vm.json')
const NAME = 'spore'
const TEMPLATE = 'template:debian-13'
const INSTALL_LIMA = 'https://lima-vm.io/docs/installation/'
const VERSION = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')).version
const PREPARE = readFileSync(join(import.meta.dirname, 'vm-prepare.sh'), 'utf8')

function fail (problem) {
  console.error(`spore: ${problem}`)
  process.exit(2)
}

function hasCore () {
  try {
    import.meta.resolve('@rhizogrip/spore')
    return true
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') return false
    throw err
  }
}

const noCore = () => process.platform === 'linux'
  ? 'this install has no @rhizogrip/spore, which runs spore on this machine — it is built for x64 and arm64 and left out by ' +
    '--omit=optional; npm install -g @rhizogrip/spore-cli adds it, or spore setup runs spore in a vm'
  : 'spore runs in a Linux vm on this machine — run spore setup'

function vmNamed () {
  if (!existsSync(VM_FILE)) return null
  let named
  try {
    named = JSON.parse(readFileSync(VM_FILE, 'utf8'))
  } catch (err) {
    fail(`${VM_FILE} is not readable JSON — ${err.message}; remove it, then spore setup`)
  }
  if (typeof named?.lima !== 'string' || !named.lima) fail(`${VM_FILE} names no vm, as { "lima": "<instance>" } — remove it, then spore setup`)
  return named.lima
}

function writeVm (vm) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  const temporary = `${VM_FILE}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ lima: vm }, null, 2) + '\n')
  renameSync(temporary, VM_FILE)
}

/** Lima's status for the vm — Running, Stopped, Broken — or null when Lima has no such instance. */
function statusOf (vm, { missing }) {
  const listed = spawnSync('limactl', ['list', '--format', '{{.Name}} {{.Status}}'], { encoding: 'utf8' })
  if (listed.error?.code === 'ENOENT') fail(missing)
  if (listed.error) throw listed.error
  if (listed.status !== 0) fail(`limactl list failed — ${listed.stderr.trim()}`)
  const found = listed.stdout.split('\n').map(line => line.split(' ')).find(([name]) => name === vm)
  return found ? found[1] : null
}

const notOnPath = (vm) => `spore runs in the vm ${vm}, made with Lima, and limactl is not on PATH — ${INSTALL_LIMA}`

function limactl (args) {
  const ran = spawnSync('limactl', args, { stdio: 'inherit' })
  if (ran.error) throw ran.error
  if (ran.status !== 0) fail(`limactl ${args.join(' ')} failed`)
}

/**
 * `command` run in the vm, in the directory this one is in where the vm sees it. Lima takes that
 * directory from `$PWD`, which a shell leaves as typed — through symlinks the vm cannot enter.
 */
function shell (vm, command) {
  const ran = spawnSync('limactl', ['shell', vm, ...command], { stdio: 'inherit', env: { ...process.env, PWD: process.cwd() } })
  if (ran.error) throw ran.error
  return ran
}

function forward (vm, args) {
  const ran = shell(vm, ['spore', ...args])
  process.exit(ran.status ?? 128 + constants.signals[ran.signal])
}

function running (vm) {
  const status = statusOf(vm, { missing: notOnPath(vm) })
  if (status === null) fail(`the vm ${vm} is gone — run spore setup`)
  if (status === 'Stopped') fail(`the vm ${vm} is stopped — run spore vm start`)
  if (status !== 'Running') fail(`the vm ${vm} is ${status} — limactl list ${vm} says why`)
}

function vmVerb (vm, args) {
  const [, sub, ...extra] = args
  if (!['start', 'stop'].includes(sub) || extra.length) fail('vm takes start or stop — spore vm start|stop')
  if (!vm) {
    if (!hasCore()) fail(noCore())
    console.error('spore: no vm — spore runs on this machine')
    process.exit(0)
  }
  const status = statusOf(vm, { missing: notOnPath(vm) })
  if (status === null) fail(`the vm ${vm} is gone — run spore setup`)
  if (sub === 'start' && status === 'Running') console.error(`spore: the vm ${vm} is running`)
  else if (sub === 'stop' && status === 'Stopped') console.error(`spore: the vm ${vm} is stopped`)
  else limactl([sub, vm])
  process.exit(0)
}

/** Whether `spore setup` makes a vm: where the core is not installed, or on a first run that chose one. */
async function wantsVm () {
  if (!hasCore()) return true
  if (existsSync(join(CONFIG_DIR, 'config.json')) || !process.stdin.isTTY || !process.stdout.isTTY) return false
  const where = await select({
    message: 'where should spore run?',
    options: [
      { value: 'here', label: 'this machine' },
      { value: 'vm', label: 'a vm', hint: 'made with Lima' }
    ],
    initialValue: 'here'
  })
  if (isCancel(where)) {
    cancel('left — spore setup again asks again')
    process.exit(130)
  }
  return where === 'vm'
}

/**
 * Makes the vm, or starts it, brings it to the Node this machine runs and the same spore-cli, names
 * it in `vm.json`, then runs its own `spore setup` — where the model and its key are chosen, so
 * this machine never holds a key.
 */
function setupVm (named) {
  if (process.platform === 'win32') fail('on Windows spore runs in WSL, which spore setup does not prepare yet')
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail('setup asks questions, and this is not a terminal')
  const vm = named ?? NAME
  const status = statusOf(vm, { missing: `spore runs in a Linux vm made with Lima — install it, ${INSTALL_LIMA}, then spore setup again` })
  if (status === null) limactl(['start', `--name=${vm}`, '--tty=false', '--containerd=none', TEMPLATE])
  else if (status !== 'Running') limactl(['start', vm])
  const prepared = shell(vm, ['sh', '-c', PREPARE, 'vm-prepare', process.version, VERSION])
  if (prepared.status !== 0) fail(`preparing the vm ${vm} failed — fix what it said, then spore setup again`)
  writeVm(vm)
  forward(vm, ['setup'])
}

/**
 * Runs before the core is loaded: settles `vm` and a `setup` that makes a vm, forwards everything
 * else to a vm `vm.json` names, and returns only when the command runs here.
 */
export async function host (args) {
  const [verb] = args
  const vm = vmNamed()
  if (verb === 'vm') vmVerb(vm, args)
  if (verb === 'setup' && (vm || await wantsVm())) setupVm(vm)
  if (vm) {
    running(vm)
    forward(vm, args)
  }
  if (!hasCore()) fail(noCore())
}
