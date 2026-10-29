# @rhizogrip/spore-plugin-mcp

MCP for spores: a client the agent runs as a program, inside its own sandbox, with each result
written to a file. Built on the official TypeScript SDK (`@modelcontextprotocol/client`).

A plugin for [spore](https://rhizogrip.com); all of them:
[rhizogrip.com/plugins](https://rhizogrip.com/plugins).

```
npm i -g @rhizogrip/spore-plugin-mcp
spore plugin allow mcp
```

A spore uses it once its `spore.cmk` says `plugins: [mcp]`. Its agent is given `$SPORE_MCP`
and `plugins/mcp.md`, and reaches the servers listed in its workspace's `data/mcp.json`, which
the agent or its owner writes.

A local server (`command`) runs inside the spore's sandbox, as any command the agent runs; a
remote one (`url`) is reached over streamable HTTP. No credential passes through the plugin: a
server that needs one is the operator's to run outside the spore, reached by URL. A cell is not
given `$SPORE_MCP`.

## License

Apache-2.0
