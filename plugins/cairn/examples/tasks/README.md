# Two spores sharing a task list

`lead` opens tasks, `worker` takes them and says when each is done. Neither tells the other
anything directly: both write to the cairn `tasks`, and each is woken by the kind it subscribed to.
The record of who opened, took and finished what, and when, stays in the cairn.

`tasks.json` is the instance file:

- three kinds — `task.open` with a title and a detail, `task.claim` with nothing beyond the task it
  names, `task.done` with a summary;
- two subjects — `task`, the `seq` of the entry that opened it, so a claim and a report cite the
  task itself, and `report`, a file stored as evidence;
- `notify` with `maxHops: 2`: a task a person has `lead` open wakes `worker`, what `worker` then
  writes wakes `lead`, and what `lead` writes after being woken wakes nobody.

## Setting it up

The cairns live under `~/cairns` here; any directory you own will do.

```bash
npm i -g @rhizogrip/spore-plugin-cairn @rhizogrip/cairn
spore plugin allow cairn root=$HOME/cairns
cat >> ~/.config/spore/environment <<EOF
CAIRN_TASKS_TOKEN=$(openssl rand -hex 32)
CAIRN_TASKS_API=$(openssl rand -hex 32)
EOF
mkdir -p ~/.config/spore/cairn && cp tasks.json ~/.config/spore/cairn/tasks.json
spore define lead --plugin cairn
spore define worker --plugin cairn
```

Add the cairn's source to `~/.config/spore/sources.json`, and its caller to
`~/.config/spore/api.json` under `callers` (with the `socket` or `listen` the file already has, or
one of its own):

```json
"cairn-tasks": {
  "url": "http://cairn/",
  "socket": "/home/you/cairns/sockets/tasks.sock",
  "methods": ["POST"],
  "paths": ["append", "evidence"],
  "headers": {
    "Authorization": "Bearer ${CAIRN_TASKS_TOKEN}",
    "X-Cairn-Actor": "{name}",
    "X-Cairn-Via": "agent",
    "X-Cairn-Id": "{turn}",
    "X-Cairn-Hop": "{hop}"
  }
}
```

```json
"cairn-tasks": { "token": "${CAIRN_TASKS_API}", "spores": ["lead", "worker"] }
```

Then give both spores the cairn, in the frontmatter of each `spore.cmk`, beside the
`plugins: [cairn]` that `define` wrote:

```
reads: [cairn-tasks=/home/you/cairns/tasks]
sources: [cairn-tasks]
```

and start the API and the cairn:

```bash
spore service define api && spore service start api
spore service define cairn@tasks && spore service start cairn@tasks
```

`spore service define cairn@tasks` checks all of the above first and says what is missing.

## Running it

```bash
spore send worker 'Subscribe to task.open in the tasks cairn. When you are told of a task, claim it, do it, and record it as done with a one-line summary.'
spore send lead 'Subscribe to task.done in the tasks cairn. Then open a task asking for the five largest files under data/, with their sizes.'
```

`lead` writes `task.open`, at hop 0, since a person started its turn. The service tells `worker` at
once: a message naming the cairn, the entry's `seq` and how to read it. `worker`'s turn reads the
task, writes `task.claim` and `task.done`, both at hop 1 and citing the task by its `seq`. The
`task.done` wakes `lead`, which subscribed to nothing else. Whatever `lead` writes in that turn is
at hop 2 and wakes nobody.

```bash
spore log worker          # the notice, and what the woken turn did
spore log lead
cairn verify ~/cairns/tasks/cairn.sqlite --evidence
spore send lead 'List every entry of the tasks cairn: seq, actor, kind, hop and refs.'
```

The first entry is `cairn.config`, the instance file the cairn was started with. The subscriptions
follow as `cairn.subscribe` entries, then the tasks: each with the spore that wrote it, the turn
it was written in, and the hash of the entry before.
