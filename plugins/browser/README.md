# @rhizogrip/spore-plugin-browser

A browser for spores: each spore its own headless Chromium-based browser, run by a service on the
host and driven by [agent-browser](https://github.com/vercel-labs/agent-browser).

A plugin for [spore](https://rhizogrip.com); all of them:
[rhizogrip.com/plugins](https://rhizogrip.com/plugins).

```
npm i -g @rhizogrip/spore-plugin-browser
spore plugin allow browser chromium=google-chrome
spore service define browser
```

`chromium` names the browser every spore's runs on, for the whole machine: any Chromium-based one, as a command on the
service's `PATH` or an absolute path — `google-chrome`, `chromium`, `brave-browser`,
`microsoft-edge` or `vivaldi`, say. `spore service define browser` runs the service's check, which
prints the browser's `--version`, and refuses a browser that does not say one. A program that does
not answer on the debugging pipe within 30 seconds is stopped, and the spore's browser commands
fail until `chromium` names one that does.

`spore service define` writes the unit and starts nothing: `spore service start browser`, and
`spore service enable browser` to start it at login.

Ubuntu's `chromium` snap runs in a confinement of its own, with a `/tmp` of its own, and the service
keeps each browser's temporary files and an ephemeral profile under `/tmp`. Use a `.deb` or the
vendor's own package instead.

A spore uses it once its `spore.cmk` says `plugins: [browser]`, and chooses its profile:

```
plugins: [browser]
browser.profile: persistent
```

- **`ephemeral`**, the default: a profile made when the spore's browser starts and deleted when it
  stops. Nothing it saw outlives it.
- **`persistent`**: a profile kept at `$XDG_STATE_HOME/spore/browser/<spore>/` (by default
  `~/.local/state/spore/browser/<spore>/`), so cookies and logins last from one turn to the next.

## What runs

The service reads each spore's `spore.cmk` and nothing else of it. It follows the definitions, so
a spore that starts using the plugin, or changes its profile, is served without a restart. For
each spore that uses it, it opens an endpoint on a loopback port, answered only on a WebSocket path
holding a 32-byte secret, and writes that address to `browser.json` in the spore's own socket
directory. Only that spore's agent can read that file.

The spore's browser starts on the first command, headless, on `--remote-debugging-pipe`: it has
no debugging port, and the service is the only way to it. It stops after 10 minutes without a command,
and when the service stops; an ephemeral profile goes with it.

## What the endpoint passes

The endpoint passes only the DevTools methods agent-browser sends for the commands the agent is
taught, and answers anything else itself with `refused by this spore's browser`, writing a line to
the service's log. Of those, it also checks the few that reach past the page:

- a page or a new tab opens only `http`, `https` or `about:blank`;
- a download goes only into the spore's `data/`, judged on the real path, through any link;
- a file uploaded comes only from the spore's `data/`, judged the same way.

`spore doctor` runs the service's check, which also tries each served spore's endpoint: without its
secret, with a method agent-browser does not use, and with an address that is not `http` or
`https`. It reports a problem only when one of them got through. To see every line:

```
node "$(npm root -g)/@rhizogrip/spore-plugin-browser/bin/spore-browser.js" --check
```

Its agent is given `$SPORE_BROWSER`, which reads `browser.json` and runs agent-browser with the
address in agent-browser's environment, never in its arguments. It is configured by environment
besides: a session named after the spore, a tab of its own (`AGENT_BROWSER_PIN_TAB`), its socket
in the spore's own socket directory (`{sockets}/browser`), and screenshots and downloads under
`data/browser/`. The agent reads how to use it in `plugins/browser.md` in its workspace.

## Logging in by hand

A persistent spore is logged in to nothing until someone logs it in. Stop the service, so that
spore's browser is not running, and open its profile in a window, with the browser `chromium` names:

```
systemctl --user stop spore-browser.service
google-chrome --user-data-dir="$HOME/.local/state/spore/browser/<spore>/profile" --password-store=basic
systemctl --user start spore-browser.service
```

Log in, close the window, then start the service again. `--password-store=basic` must match the
service's, or the headless browser cannot read what the window saved.

## Not yet

Each browser runs as your user, outside the sandbox. The endpoint checks what a spore asks of its
browser, but a page it opens can still do what the browser lets a page do, and a path the endpoint
judged can change before the browser uses it. Holding the browser itself to the spore's grants is
the next step.
