/**
 * A provider that answers from a script instead of from a network.
 *
 * Shaped like what `createModelServer` answers from: `mo.use(id)` returns something with an
 * `info()` and an `answer()`. The socket is real, the confinement
 * is real; only the replies are decided in advance, which is what makes a process test
 * assert the same thing twice in a row.
 */

export function scriptedMo (reply, { contextTokenLimit = 200000, turnTokenBase = 12000 } = {}) {
  const seen = []
  return {
    seen,
    use: (modelId) => ({
      id: modelId,
      info: () => ({ contextTokenLimit, turnTokenBase }),
      answer: async (input, options = {}) => {
        seen.push(input)
        const said = await reply(input, seen.length - 1, options)
        return { cost: 0.01, ...said }
      }
    })
  }
}

/** The shape a turn ends on. */
export const answers = (output, cost = 0.01) => ({ status: 'completed', output, cost })

/** The shape a round that calls one tool takes. */
export const calls = (name, args, cost = 0.01) => ({
  status: 'tool_use',
  output: '',
  toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name, arguments: args }],
  cost
})
