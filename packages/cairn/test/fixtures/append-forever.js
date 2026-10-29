import { openCairn } from '../../src/index.js'

const [file] = process.argv.slice(2)
const cairn = openCairn(file, { name: 'ops' })
for (let n = 1; ; n++) {
  cairn.append({
    at: '2026-10-29T10:00:00.000Z',
    kind: 'task.claim',
    refs: { task: n, customer: `cus_${n % 7}` },
    data: { note: 'x'.repeat(200) },
    actor: { name: 'main', role: 'lead', via: 'agent' },
    id: 'turn-1',
    hop: 0
  })
  if (n === 50) process.stdout.write('appending\n')
}
