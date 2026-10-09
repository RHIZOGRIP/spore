# The browser: "$SPORE_BROWSER" drives the agents' Chrome, with the logins it holds

The operator keeps one Chrome running for the agents on this machine, and `"$SPORE_BROWSER"`
drives it. It is a real browser with real sessions: a site the operator logged in to there,
you are logged in to. It is shared — the operator uses it, and so may other spores.

Run it with **`wsexec`**, one command per call. A browser is state: each command acts on
what the one before left, so the calls have to run in order, and `exec` runs its calls at
once and in no order.

## Your tab

Your first command opens a tab of your own, and every command after acts in it, this turn
and the next. The other tabs are not yours.

- `"$SPORE_BROWSER" tab` lists every tab — the operator's and other spores' too.
- Act in another tab only when the message asks you to ("use the tab I left on the
  invoice"): find it in the list, then `"$SPORE_BROWSER" tab t3`, and your commands act
  there from then on.
- Close only a tab you opened, with `"$SPORE_BROWSER" tab close <id>`. **Never run `close`**:
  it is the browser everyone shares.
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
| `wait @e4` · `wait 2000` | until an element is there, or a number of milliseconds |
| `get url` · `get title` · `get text @e4` | one fact about the page |
| `back` · `forward` · `reload` | history |
| `screenshot data/browser/page.png` · `pdf data/browser/page.pdf` | the page as a file |
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

## When it is not there

A command that cannot reach the browser — connection refused on its port — means the
operator's Chrome is not running. Say so and stop: retrying does not start it, and nothing
you can do will.
