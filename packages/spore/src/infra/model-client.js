/**
 * The agent's model access: mohdel's call protocol on the tree's model socket, which the
 * runner serves (ARCHITECTURE §The model broker). `runSpore` takes it as `opts.mo`.
 *
 *   const mo = await createModelClient({ socketPath, modelIds, key })
 *   mo.use(id).info()                      // synchronous, fetched once here
 *   await mo.use(id).answer(prompt, opts)  // prompt: wire Message[]
 *   await mo.use(id).embed(input, opts)    // input: string[]
 *
 * A call is a `CallEnvelope` built here from spore's wire-form messages; streaming and the
 * events are mohdel's (`mohdel/client`). The runner fills the provider key, so the envelope
 * carries none.
 *
 * Nothing here stops a call. On an abort the caller stops waiting and the runner reads the
 * call to its end, counting it for the turn that made it (ARCHITECTURE §The model broker): a started call
 * is billed in full whoever stops it.
 */

import { createHash, randomUUID } from 'node:crypto'

import { call, callEmbedding, coalesce } from 'mohdel/client'

import { formatTraceparent } from '../observability/tracing.js'
import { SporeError } from '../observability/errors.js'
import { CALLER_HEADER, MODEL_CALL_HEADER, KEY_HEADER, PRECURSOR_CALLER, ROOT_CALLER, request, typedError } from './socket-request.js'

const OPTIONS = new Set(['tools', 'signal', 'parentSpan', 'realtimeHandler', 'bufferOpts'])

const ask = (socketPath, key, method, path, body) => request(socketPath, { key, method, path, body, what: 'model socket' })

/**
 * `tracksTree` says whose spend this caller answers for. An agent that can spawn is
 * measured against everything drawn on its allowance, cells included — that is what makes
 * its ceiling a bound on the tree. A cell is measured against its own precursor's budget:
 * the difference between the tree's total and its own spend is its *parent's*. `precursor` names
 * the cell's on every call, so the tree's record can say what each precursor spent.
 * `workspace` names the conversation to the provider, as mohdel's `identifier`, which an
 * OpenAI call carries as `prompt_cache_key`: without one, calls that share a prefix are not
 * routed to where it is cached.
 */
export async function createModelClient ({ socketPath, modelIds = [], key, logger, tracksTree = false, precursor = null, workspace }) {
  const identifier = createHash('sha256').update(workspace).digest('hex').slice(0, 32)
  const info = new Map()
  for (const modelId of modelIds) info.set(modelId, await ask(socketPath, key, 'POST', '/spore/info', { model: modelId }))

  const ledger = { own: 0, children: 0, ownRounds: 0, childRounds: 0 }
  // The runner counts the tree, and the root agent's share of it by the answers it marks.
  const settle = async () => {
    const { spend, rounds, own, ownRounds } = await ask(socketPath, key, 'GET', '/spore/spend')
    ledger.children = Math.max(0, spend - own)
    ledger.ownRounds = ownRounds
    ledger.childRounds = rounds - ownRounds
    return ledger
  }
  const keyed = key ? { [KEY_HEADER]: key } : {}
  const caller = tracksTree ? ROOT_CALLER : precursor ? `${PRECURSOR_CALLER}${precursor}` : null

  return {
    logger,
    ...(tracksTree ? { ledger, spend: settle } : {}),
    close () {},
    use (modelId) {
      return {
        id: modelId,
        info: () => info.get(modelId) ?? null,
        async answer (prompt, options = {}) {
          const unknown = Object.keys(options).filter(name => !OPTIONS.has(name))
          if (unknown.length) {
            throw new SporeError(`a model call does not take ${unknown.join(', ')}`, {
              type: 'BROKER_BAD_OPTION',
              detail: `the envelope carries ${[...OPTIONS].join(', ')}`
            })
          }
          const { tools, signal, parentSpan, realtimeHandler, bufferOpts } = options
          const traceparent = formatTraceparent(parentSpan)
          const envelope = {
            callId: randomUUID(),
            authId: 'spore',
            model: modelId,
            identifier,
            prompt,
            ...(tools?.length ? { tools } : {}),
            ...(traceparent ? { traceparent } : {})
          }
          // To the loop an abort is a rejection, which writes the turn down as cancelled.
          const cancelled = () => new SporeError('operation cancelled', { type: 'OPERATION_CANCELLED', detail: 'the call was left to finish without it', severity: 'info' })
          if (signal?.aborted) throw cancelled()
          const events = call(envelope, { socketPath, headers: { ...keyed, [MODEL_CALL_HEADER]: envelope.callId, ...(caller ? { [CALLER_HEADER]: caller } : {}) } })
          const reading = (realtimeHandler ? coalesce(events, bufferOpts ?? {}) : events)[Symbol.asyncIterator]()
          let stopWaiting
          const stopped = new Promise(resolve => { stopWaiting = () => resolve(null) })
          signal?.addEventListener('abort', stopWaiting, { once: true })
          let result = null
          try {
            while (true) {
              // Left unread on an abort: the connection goes with this process, and the
              // runner has the call either way.
              const next = await Promise.race([reading.next(), stopped])
              if (!next) throw cancelled()
              if (next.done) break
              const event = next.value
              if (event.type === 'delta') realtimeHandler?.(event.delta)
              else if (event.type === 'error') throw typedError(event.error)
              else if (event.type === 'done') result = event.result
            }
          } finally {
            signal?.removeEventListener('abort', stopWaiting)
          }
          if (!result) throw new SporeError('the model call ended without an answer', { type: 'BROKER_FAILED' })
          if (tracksTree) await settle()
          return result
        },
        // Not marked as the root's own: the loop counts only answers as its own, so an
        // embedding reaches the tree's ledger through `children` on the next settle.
        async embed (input, { inputType, signal } = {}) {
          const envelope = { callId: randomUUID(), authId: 'spore', model: modelId, input, ...(inputType ? { inputType } : {}) }
          try {
            return await callEmbedding(envelope, { socketPath, signal, headers: { ...keyed, ...(caller ? { [CALLER_HEADER]: caller } : {}) } })
          } catch (e) {
            throw typedError(e)
          }
        }
      }
    }
  }
}
