# spore tui

One spore at a time, in a terminal screen.

```bash
spore tui [<name>]      # the last one opened, without a name
```

```
enter          send; to a running turn, it lands between its rounds
alt+enter      a new line
↑ ↓            earlier messages
ctrl+p         open another spore
ctrl+o         tool calls in full — an edit or a write as its diff
ctrl+g         write the message in $EDITOR
esc esc        stop the running turn; when none runs, clear the line
ctrl+c         clear the line
ctrl+d         leave, on an empty line
/              commands: /stop /wrap /extend /model /curate /pause /unpause /spores /status /copy /help /quit
//text         a message that starts with /
```

The status line names the spore, its model, its state and the running turn's limits. When
another spore answers or asks, the status line says so and the terminal gets a notification
(OSC 9); so does the open one when a turn ran longer than a minute.

## In a directory

`spore here [<dir>]` opens the spore that works in that directory, in place, making it the first
time from a sporangium you pick. It adds two commands:

```
/diff          what changed here since this session opened, in git's pager — your changes too
/undo          put the directory back as this session found it, after showing what that changes
```

## Embedding it

`runTui({ ws, commands, renderTool })` from `@rhizogrip/spore-cli/tui/index.js` is the same
screen, with an application's own slash commands added and its own way of drawing a tool call;
[INTEGRATION.md](../../../INTEGRATION.md#a-terminal-for-your-application) has its options. It is
not a declared entry point yet, so the path may change in a release.
