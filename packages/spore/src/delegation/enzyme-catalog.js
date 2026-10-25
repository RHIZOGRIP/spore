/**
 * What a cell is told about the enzymes its precursor granted.
 *
 * The mirror of `precursorRules`: the spore's `rules` lists the sub-agents it can
 * spawn, a cell's lists the enzymes it can call. Both answer the same question — what
 * can I reach beyond my built-ins — and both go in the slot that is concatenated
 * into the cached foundation block, which for a cell is stable by construction:
 * it lives one turn.
 */

const INDENT = '  '

export function enzymeRules (enzymes) {
  if (!enzymes.length) return ''
  const lines = [
    'Tools you can call that are not built in. Each is a program reached by name:',
    `${INDENT}exec with command: node "$SPORE_ENZYME" <name> [args]`,
    `${INDENT}(use wsexec instead when the tool writes a file)`,
    'Its stdin, stdout, stderr and exit code are the call contract, as with any command.',
    ''
  ]
  for (const enzyme of enzymes) {
    lines.push(`- ${enzyme.name}`)
    for (const line of enzyme.description.split('\n')) lines.push(`${INDENT}${line}`)
  }
  return lines.join('\n')
}
