import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const server = new McpServer({ name: 'fixture', version: '1.0.0' })

server.registerTool('echo', { description: 'Says back what it was given.\nA second line.', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text }] }))

server.registerTool('weather', { description: 'A forecast, structured.', inputSchema: { city: z.string() }, outputSchema: { city: z.string(), celsius: z.number() } },
  async ({ city }) => ({ content: [{ type: 'text', text: `${city}: 21` }], structuredContent: { city, celsius: 21 } }))

server.registerTool('pixel', { description: 'One red pixel.' },
  async () => ({ content: [{ type: 'text', text: 'a pixel' }, { type: 'image', data: PIXEL, mimeType: 'image/png' }] }))

server.registerTool('fails', { description: 'Always an error.' },
  async () => ({ content: [{ type: 'text', text: 'it went wrong' }], isError: true }))

server.registerTool('slow', { description: 'Takes three seconds.' },
  async () => {
    await new Promise(resolve => setTimeout(resolve, 3000))
    return { content: [{ type: 'text', text: 'done' }] }
  })

await server.connect(new StdioServerTransport())
