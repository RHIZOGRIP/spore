/**
 * One host command through a sluice broker, exiting as sluice's own client does: the command's
 * code, 124 past its timeout, 128 + the broker's error otherwise, 2 when no broker answered.
 */

const REFUSED = new Map([
  [-1, 'no rule allows this command — node "$SPORE_SLUICE" --list says what you may run'],
  [-2, 'the broker did not understand the request'],
  [-3, 'the broker did not receive this program\'s input and output'],
  [-4, 'the broker could not start the command on the host'],
  [-6, 'the broker could not record the call, so it did not run it'],
  [-7, 'the command ran past the time its rule allows'],
  [-8, 'the broker could not tell who was calling, so it did not run it']
])

export const listPath = (socket) => `${socket.replace(/\.sock$/, '')}.md`

export function exitOf (status) {
  if (status >= 0) return { code: status, said: null }
  return { code: status === -7 ? 124 : 128 - status, said: REFUSED.get(status) ?? `the broker refused the call (${status})` }
}

export function run (argv, { socket, call, read, print, say }) {
  if (!socket) {
    say('no broker is named — the operator allows this plugin with: spore plugin allow sluice socket=<path>')
    return 2
  }
  const [command, ...args] = argv
  if (!command) {
    say('usage: node "$SPORE_SLUICE" <command> [args…], or --list for what you may run')
    return 2
  }
  if (command === '--list') {
    const listed = read(listPath(socket))
    if (listed === null) {
      say(`${listPath(socket)} is not there — nothing says what you may run, so ask rather than try`)
      return 2
    }
    print(listed)
    return 0
  }
  let status
  try {
    status = call(socket, [command, ...args])
  } catch (err) {
    say(`the broker at ${socket} cannot be reached — ${err.message}`)
    return 2
  }
  const { code, said } = exitOf(status)
  if (said) say(said)
  return code
}
