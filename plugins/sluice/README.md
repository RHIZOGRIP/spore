# @rhizogrip/spore-plugin-sluice

Host commands for spores, through [sluice](https://github.com/clbrge/sluicify): a broker on the
host runs the commands its rules allow — a service's status, a restart, its journal — with the
spore's input and output, and refuses everything else.

```
cargo install sluicify                       # sluice, the broker, and sluicify, its client
npm i -g @rhizogrip/spore-plugin-sluice
mkdir -p ~/.config/sluice
cp "$(npm root -g)/@rhizogrip/spore-plugin-sluice/examples/spore."* ~/.config/sluice/
sluice check ~/.config/sluice/spore.rules
spore service define sluice                  # writes the unit, prints the next line
spore plugin allow sluice socket=/run/user/$(id -u)/sluice/spore.sock
```

A spore uses it once its `spore.cmk` says `plugins: [sluice]`. Its agent is given
`$SPORE_SLUICE`, the client, and reads how to use it in `plugins/sluice.md`.

## Two files, both yours

- `~/.config/sluice/spore.rules` — what the broker runs. Every rule is a whole command line, each
  variable part a slot with a regex; `sluice match spore.rules <argv…>` says whether one would run.
  The [rules reference](https://github.com/clbrge/sluicify/blob/main/REFERENCE.md) has the rest.
- `~/.config/sluice/spore.md` — what the agent reads with `--list`. You write it yourself. Leave
  out anything secret in the rules, such as an `env` value. The unit copies it beside the socket
  each time it starts.

Change either, then `spore service restart sluice`.

## What it does not isolate

sluice authorises by socket: whoever can connect to one may run its rules. A spore's sandbox does
not gate connecting to a unix socket, so a spore can reach **every** sluice broker of the user it
runs as — this one, and any other, such as an agent broker's — if it knows the path and writes a
client. Write every broker's rules for that. What spores must not reach runs as another user.
