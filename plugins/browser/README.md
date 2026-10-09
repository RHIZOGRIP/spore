# @rhizogrip/spore-plugin-browser

A browser for spores: the agents' own Chrome, reached over the Chrome DevTools Protocol and
driven by [agent-browser](https://github.com/vercel-labs/agent-browser).

```
npm i -g @rhizogrip/spore-plugin-browser
google-chrome --remote-debugging-port=9222 --user-data-dir=<a profile for the agents>
spore plugin allow browser cdp=9222
```

A spore uses it once its `spore.cmk` says `plugins: [browser]`. Its agent is given
`$SPORE_BROWSER`, the agent-browser binary, configured by environment: the port, a session
named after the spore, a tab of its own (`AGENT_BROWSER_PIN_TAB`), its socket in the spore's own
socket directory (`{sockets}/browser`, which no other spore can write), and screenshots and
downloads under `data/browser/`. The agent reads
how to use it in `plugins/browser.md` in its workspace.

**Chrome is the operator's.** Spore never starts or stops it. Chrome 136 and later ignore
the debugging switch on the default data directory, so the agents' Chrome has a profile of
its own, holding the logins you give the agents and nothing else.

**The port is shared on trust.** It has no authentication, and the sandbox leaves TCP
connect open, so any process on the machine can reach it — every spore, whether its
definition names this plugin or not. `plugins: [browser]` says which spores are offered the
browser, not which can reach it. That is accepted because the profile is the agents' own:
nothing in it is more than an agent already has. Use a profile that holds nothing you would
not hand to every spore on the machine.
