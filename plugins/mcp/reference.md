# mcp — tools of MCP servers

`"$SPORE_MCP"` is an MCP client. The servers it can reach are `data/mcp.json`, which you or your
owner write:

```json
{
  "everything": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] },
  "docs": { "url": "https://example.org/mcp" }
}
```

`command` starts a local server over stdio, inside your sandbox like any command you run; `url`
reaches a remote one. Never put a secret in this file — a server that needs one is your owner's
to run, outside this spore.

```
"$SPORE_MCP" --list                                   the servers
"$SPORE_MCP" <server> --tools                         each tool's name and first line
"$SPORE_MCP" <server> --describe <tool>               its input schema
"$SPORE_MCP" <server> <tool> --args <file.json> --out <file|->
"$SPORE_MCP" <server> --calls <file.jsonl> --out-dir <dir>
```

- **Look before you call**: `--tools`, then `--describe` for the one you want. Schemas are not in
  your prompt; this is how you learn them.
- **A call's result goes to `--out`.** Under `exec`, which cannot write `data/`, use `--out -`: the
  result is on stdout, which the call's `out` holds, and one JSON line saying what happened is on
  stderr. Under `wsexec`, `--out data/<file>` writes the file and prints that line on stdout.
- **What a result becomes**: the server's structured content as JSON when it gives one, its text
  otherwise. Images, audio and embedded files are written beside `--out` as `<out>.1.png` and so
  on, listed in `files` — which needs a file, so a call returning them under `--out -` exits 1.
- **The exit code is the answer.** 0 is a result; 1 is a tool that answered with an error (its
  text is still in the file), a server that did not start, or a request past `--timeout` (60 s);
  2 is a call you wrote wrong.
- **Many calls**: `--calls` takes one JSON object a line — `{ "tool", "args", "out" }` — and makes
  them all in one session, one result line each. Fifty calls this way start the server once.
- Each invocation is one session: a server keeps no state from one `"$SPORE_MCP"` to the next,
  except within one `--calls` run.
- A server started with `npx` downloads itself into your `home/` the first time, so its first run
  needs `wsexec`; after that it runs under `exec`.
