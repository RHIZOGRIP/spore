# The browser: "$SPORE_BROWSER" drives a browser of your own

`"$SPORE_BROWSER"` drives a headless browser that is yours alone: no other spore reaches it. It
starts with your first command and stops after ten minutes without one.

Your `spore.cmk` says which profile it keeps, as `browser.profile:`. **`ephemeral`**, the default,
starts empty each time and forgets everything when it stops. **`persistent`** keeps cookies and
logins from one turn to the next; a site the operator logged you in to, you are logged in to.

Run it with **`wsexec`**, one command per call. A browser is state: each command acts on
what the one before left, so the calls have to run in order, and `exec` runs its calls at
once and in no order.

## Your tab

Your first command opens a tab, and every command after acts in it, for as long as the browser
runs.

- `"$SPORE_BROWSER" tab` lists the tabs; `"$SPORE_BROWSER" tab t3` acts in another from then on.
- `"$SPORE_BROWSER" tab close <id>` closes one. Don't run `close`: your browser stops on its
  own after ten minutes without a command.
- A command that fails with `tab_gone` means your tab was closed. `"$SPORE_BROWSER" tab new`
  opens another.

## Looking and acting

Open a page, take a snapshot, act on what it shows by ref, and take a snapshot again:

```
"$SPORE_BROWSER" open https://example.com       the page's title
"$SPORE_BROWSER" snapshot -i                    what you can act on: - link "Pricing" [ref=e12]
"$SPORE_BROWSER" click @e12
"$SPORE_BROWSER" fill @e3 "invoice 2026-114"
"$SPORE_BROWSER" press Enter
```

A ref names an element in the last snapshot. Once the page changes, take a new snapshot
before using refs again.

| command | does |
|---|---|
| `open <url>` | goes there, and says the title |
| `snapshot -i` | the elements you can act on, each with its ref |
| `snapshot` | the whole page as a tree — several times longer |
| `read` | the page as text, for reading rather than acting |
| `click @e12` · `fill @e3 "text"` · `type @e3 "text"` | act on an element |
| `press Enter` · `select @e7 "value"` · `scroll down 600` | keys, dropdowns, scrolling |
| `wait --text "Saved"` · `wait 2000` | until the page shows that text, or a number of milliseconds |
| `get url` · `get title` · `get text @e4` | one fact about the page |
| `back` · `forward` · `reload` | history |
| `screenshot data/browser/page.png` · `pdf data/browser/page.pdf` | the page as a file |
| `download @e5 data/out/report.pdf` · `upload @e9 data/form.pdf` | a file from the page, or to it |
| `tab` · `tab new [url]` · `tab <id>` · `tab close <id>` | tabs |

`"$SPORE_BROWSER" --help` lists every command, and `"$SPORE_BROWSER" skills get core` prints
the tool's own guide, matched to this version.

## What it prints goes to a file

A snapshot of a large page is a hundred kilobytes or more, and `read` returns the page's
whole text. Name `out` for those, as for any stream — `wsexec` with command
`"$SPORE_BROWSER" snapshot -i` and out `data/browser/snapshot.txt` — and then read the part
you need, or grep it. What `open`, `click` or `get url` print is a line, and comes back in
the call record.

## Pictures

`"$SPORE_BROWSER" screenshot data/browser/page.png` writes a PNG — `mkdir -p data/browser`
first — and `read` shows it to you when your definition lets you look at images. Prefer a snapshot: a picture costs more and
says less about what you can click.

## What it refuses

Your browser opens `http` and `https` addresses and `about:blank`, nothing else. A download goes
only into your `data/`, and an upload comes only from it: copy a file into `data/` before
uploading it. A command that asks for anything else fails with `refused by this spore's browser`
and why. That is a rule, not a fault: running it again gets the same answer.

## When it is not there

`browser: this spore has no browser` means the operator's browser service is not running, or has
not seen this spore yet. Say so and stop: retrying does not start it, and nothing you can do will.
A command that worked a moment ago and now cannot connect means the browser stopped; the next
command starts it again.
