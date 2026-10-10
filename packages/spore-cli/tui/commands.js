export const COMMANDS = [
  { name: 'stop', description: 'stop the running turn' },
  { name: 'wrap', description: 'ask the running turn to wrap up, now or in a while', argumentHint: '[10m]' },
  { name: 'extend', description: 'give the running turn more, as far as its spore.cmk allows', argumentHint: '<rounds|cost|wall> <amount>' },
  { name: 'model', description: 'switch the model this spore runs on, from the next turn — a list to pick from, or one named', argumentHint: '[<model>]' },
  { name: 'curate', description: 'add a model a provider lists to your mohdel catalog — this spore\'s provider unless one is named', argumentHint: '[<provider>]' },
  { name: 'pause', description: 'stop every turn and job of your spores, and start none' },
  { name: 'unpause', description: 'let turns start again' },
  { name: 'spores', description: 'open another spore (Ctrl+P)' },
  { name: 'status', description: 'jobs, schedules, held deliveries, answers waiting to be delivered' },
  { name: 'copy', description: 'copy the last answer, or code block <n> of it as numbered on screen (Alt+C: the last one)', argumentHint: '[<n>]' },
  { name: 'help', description: 'keys and commands' },
  { name: 'quit', description: 'leave (Ctrl+D)' }
]

/** `/name args…` as `{ name, args }`; null for a message — `//…` being one that starts with `/`. */
export function parseCommand (text) {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return null
  const [name, ...args] = trimmed.slice(1).split(/\s+/)
  return name ? { name: name.toLowerCase(), args } : null
}
