import { describe, it, expect } from 'vitest'
import { loop } from '../src/core/loop.js'

function mockModel (responses) {
  let i = 0
  return { answer: async () => responses[i++] }
}

function toolUse (calls) {
  return {
    status: 'tool_use',
    output: '',
    toolCalls: calls.map((c, i) => ({ id: `call_${i}`, name: c.name, arguments: c.args }))
  }
}

function completed (text) {
  return { status: 'completed', output: text }
}

describe('extra tools (precursor custom tools)', () => {
  it('extra tool fn is callable from the loop', async () => {
    const convertCalls = []
    const extraTool = {
      name: 'convert',
      description: 'Convert a file',
      parameters: { type: 'object', properties: { path: { type: 'string' }, target: { type: 'string' } }, required: ['path', 'target'] },
      fn: ({ path, target }, { workspace, logger }) => {
        convertCalls.push({ path, target, workspace })
        return `ok: ${path} → ${path.replace(/\.\w+$/, '.' + target)}`
      }
    }

    // Simulate cell toolFns with the extra tool merged in
    const toolFns = {
      convert: (args) => extraTool.fn(args, { workspace: '/test', logger: { debug () {} } })
    }
    const tools = [{ name: extraTool.name, description: extraTool.description, parameters: extraTool.parameters }]

    const m = mockModel([
      toolUse([{ name: 'convert', args: { path: 'doc.docx', target: 'pdf' } }]),
      completed('Converted successfully')
    ])

    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'convert doc', tools, toolFns })
    expect(res.output).toBe('Converted successfully')
    expect(convertCalls).toHaveLength(1)
    expect(convertCalls[0]).toEqual({ path: 'doc.docx', target: 'pdf', workspace: '/test' })

    const toolResult = res.messages.find(m => m.role === 'tool')
    expect(toolResult.content).toBe('ok: doc.docx → doc.pdf')
  })

  it('extra tool errors are captured like built-in tools', async () => {
    const toolFns = {
      convert: () => { throw new Error('converter unreachable') }
    }
    const tools = [{ name: 'convert', description: 'Convert', parameters: { type: 'object', properties: {} } }]

    const m = mockModel([
      toolUse([{ name: 'convert', args: {} }]),
      completed('Handled error')
    ])

    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'convert', tools, toolFns })
    const toolResult = res.messages.find(m => m.role === 'tool')
    expect(toolResult.content).toBe('error: converter unreachable')
  })

  it('extra tool can be async', async () => {
    const toolFns = {
      convert: async ({ path }) => {
        await new Promise(resolve => setTimeout(resolve, 1))
        return `done: ${path}`
      }
    }
    const tools = [{ name: 'convert', description: 'Convert', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]

    const m = mockModel([
      toolUse([{ name: 'convert', args: { path: 'file.docx' } }]),
      completed('ok')
    ])

    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'go', tools, toolFns })
    const toolResult = res.messages.find(m => m.role === 'tool')
    expect(toolResult.content).toBe('done: file.docx')
  })

  it('extra tools coexist with built-in tools', async () => {
    const toolFns = {
      echo: ({ text }) => text,
      convert: ({ path }) => `converted: ${path}`
    }
    const tools = [
      { name: 'echo', description: 'Echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
      { name: 'convert', description: 'Convert', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
    ]

    const m = mockModel([
      toolUse([
        { name: 'echo', args: { text: 'hello' } },
        { name: 'convert', args: { path: 'doc.pdf' } }
      ]),
      completed('both worked')
    ])

    const res = await loop({ limits: { rounds: { soft: 10, hard: 12 } }, model: m, system: 'sys', prompt: 'go', tools, toolFns })
    const results = res.messages.filter(m => m.role === 'tool')
    expect(results[0].content).toBe('hello')
    expect(results[1].content).toBe('converted: doc.pdf')
  })
})
