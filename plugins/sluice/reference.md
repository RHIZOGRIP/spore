# sluice: the host commands your operator allows

Everything outside your workspace and the directories you are granted is out of your reach, and a
task that needs it is usually one to hand back. sluice is the exception your operator chose: a
broker on the host that runs, for you, the commands its rules allow — a service's status, a restart,
its journal — with your input and output.

## When a task reaches past your workspace, look here first

Before you try something outside your workspace yourself — writing a file elsewhere, touching a
service, anything the sandbox will refuse — read what you may ask for. It is one call:

```
exec  command: node "$SPORE_SLUICE" --list
```

It prints each command your operator allows, every part you fill in shown as `<name>`, then what
the command is for and what each part may be:

```
systemctl --user restart <unit>
  Restart one of the shop's services.
  <unit> matches (shop|shop-worker)\.service
```

If what the task needs is there, run it as listed. If it is not, nothing you can do reaches it:
hand it back, saying exactly what to run and why, and stop there.

## Running one

```
exec  command: node "$SPORE_SLUICE" systemctl --user restart shop.service
exec  command: printf '%s' "$text" | node "$SPORE_SLUICE" <command>     what you pipe in reaches it
```

`exec` is enough — the command runs on the host, not in your workspace — and what it prints comes
back as the call's output, as if it had run here. Its exit code is the call's.

The broker matches the whole command line against its rules, word by word, so use a command
exactly as `--list` shows it:

- the same words in the same order, nothing added — no extra option, no `2>&1` or `;` inside it;
- a part shown as `<name>` is yours to fill with one word, within what the list says it may be;
- a value starting with `-` is refused there unless the list says it `may start with -`.

## When it says no

The broker's refusals end with a line on stderr saying what went wrong:

| exit | meaning | what to do |
|---|---|---|
| 129 | no rule allows that command line | compare it with `--list` word by word; if it is not listed, hand it back |
| 124 | it ran past the time its rule allows | say so; do not run it again in a loop |
| 2 | no broker answered, or none is named for you | say so and stop — nothing in your workspace can fix it |

Never look for another way to the host: no client of your own on the socket, no other socket, no
workaround through files. The broker and its rules are the whole of what your operator allows.
