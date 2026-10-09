# @rhizogrip/spore-cli

The `spore` command: define a spore, send it a message, follow what it does, and manage the
spores, schedules, jobs, plugins and services of a machine. It is argument parsing over
[`@rhizogrip/spore`](https://www.npmjs.com/package/@rhizogrip/spore), which it installs. It also
carries `tui/`, a terminal over the same library.

```bash
npm install -g @rhizogrip/spore-cli
spore                      # what each command does
```

The terminal screen (`spore tui`, `spore here`) is an optional dependency: `--omit=optional` leaves it
out, for a server, and the other commands work without it.

Linux x64, Node 24 or newer. How spore works, what a spore is and every command:
[the spore README](https://github.com/RHIZOGRIP/spore/blob/main/packages/spore/README.md).

## License

Apache-2.0
