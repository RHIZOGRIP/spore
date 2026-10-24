# @rhizogrip/spore-plugin-sluice

Host commands for spores, through [sluice](https://github.com/clbrge/sluicify): a broker on the
host runs the commands a spore's rules allow — a service's status, a restart, its journal — with
the spore's input and output, and refuses everything else. Each spore has its own rules and its
own socket, and sees no other.

```
cargo install sluicify                       # sluice, the broker, and sluicify, its client (0.4 or later)
npm i -g @rhizogrip/spore-plugin-sluice
mkdir -p ~/.config/spore/sluice
cp "$(npm root -g)/@rhizogrip/spore-plugin-sluice/examples/spore.rules" ~/.config/spore/sluice/main.rules
sluice check ~/.config/spore/sluice/main.rules
spore service define sluice                  # writes the unit, prints the next line
spore plugin allow sluice dir=/run/user/$(id -u)/sluice
```

A spore uses it once its `spore.cmk` says `plugins: [sluice]` and
`~/.config/spore/sluice/<spore>.rules` says what it may run. Its agent is given `$SPORE_SLUICE`,
the client, and reads how to use it in `plugins/sluice.md`.

## One file per spore, yours

`~/.config/spore/sluice/<spore>.rules` is what the broker runs for that spore, on its own socket,
`/run/user/<uid>/sluice/spores/<spore>/sluice.sock`. Every rule is a whole command line, each
variable part a slot with a regex; `sluice match <spore>.rules <argv…>` says whether one would
run. The comment lines written directly above a rule are what the agent reads it is for, with
`--list`; nothing else in the file reaches it. The
[rules reference](https://github.com/clbrge/sluicify/blob/main/REFERENCE.md) has the rest.

Adding, changing or removing a file takes effect within a second, with no restart. A spore whose
file is missing, or whose rules do not parse, has no socket, and its turns are refused, saying
so.

## What it isolates

A spore using the plugin runs contained, in a mount namespace of its own, where
`/run/user/<uid>/sluice` is an empty directory with only `spores/<spore>/` put back. It reaches its
own socket and no other spore's, and none of the other sluice brokers of its user, an agent
broker's included. A spore that is not contained (`spore config set contain off`, or a host
without user namespaces) would see them all, so its turns, jobs, routers and prepare steps are refused instead.

Processes of the user outside spore are not contained: they reach every socket, as they could run
the commands themselves. What must stay out of reach of those runs as another user.
