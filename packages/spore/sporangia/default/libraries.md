# Libraries

Installed for your programs to import, by name, no path. Reach for one before writing the
hard part yourself: quoting in CSV, offsets in a time zone and rounding in decimal money
are where hand-written code is wrong in ways that look right.

Every example below is run by spore's own test suite, against these versions. The output
shown is the output you get.

Nothing else is installed but what a plugin this spore uses adds — `plugins/<name>.md` says
what, documents and images among them. For anything else the machine's own commands are there
under `exec` and `wsexec`.

## Data formats

### `csv-parse` / `csv-stringify` — CSV with the quoting right

```js
import { parse } from 'csv-parse/sync'
console.log(JSON.stringify(parse('name,note\nbolt,"12, boxed"\n', { columns: true })))
```
```
[{"name":"bolt","note":"12, boxed"}]
```

```js
import { stringify } from 'csv-stringify/sync'
console.log(JSON.stringify(stringify([{ name: 'bolt', note: '12, boxed' }], { header: true })))
```
```
"name,note\nbolt,\"12, boxed\"\n"
```

Every value comes back a string — cast what you need. Drop `/sync` for the streaming API
when the file is too large to hold.

### `yaml` — parse and write YAML

```js
import { parse, stringify } from 'yaml'
console.log(JSON.stringify(parse('name: bolt\nsizes: [4, 6]\n')))
console.log(JSON.stringify(stringify({ a: 1, b: ['x'] })))
```
```
{"name":"bolt","sizes":[4,6]}
"a: 1\nb:\n  - x\n"
```

To edit a file and keep its comments, use `parseDocument`, change the document, and
`String(doc)`.

### `cheerio` — HTML with selectors, no browser

```js
import * as cheerio from 'cheerio'
const $ = cheerio.load('<table><tr><td>bolt</td><td>12</td></tr></table>')
console.log(JSON.stringify($('td').map((i, el) => $(el).text()).get()))
```
```
["bolt","12"]
```

jQuery selectors over a parsed document. `.get()` turns the cheerio set into an array.

### `fast-xml-parser` — XML in and out

```js
import { XMLParser } from 'fast-xml-parser'
console.log(JSON.stringify(new XMLParser().parse('<order><item>bolt</item><qty>12</qty></order>')))
```
```
{"order":{"item":"bolt","qty":12}}
```

Numeric-looking text is converted by default — pass `{ parseTagValue: false }` to keep
strings. Attributes are ignored unless you pass `{ ignoreAttributes: false }`.

### `fflate` — zip and gzip

```js
import { strToU8, strFromU8, zipSync, unzipSync, gzipSync, gunzipSync } from 'fflate'
const zip = zipSync({ 'a.txt': strToU8('hello') })
console.log(JSON.stringify(Object.keys(unzipSync(zip))))
console.log(strFromU8(gunzipSync(gzipSync(strToU8('hello')))))
```
```
["a.txt"]
hello
```

Everything is `Uint8Array`; `strToU8` and `strFromU8` cross to and from text. This is also
how you reach inside a docx or xlsx by hand.

**Tarballs are the system `tar`, not this.** `fflate` will gunzip a `.tar.gz` and leave you
a tar archive to parse, which is not worth doing:

```
wsexec: tar -xzf data/bundle.tgz -C data/src     # also -j, -J, --zstd
wsexec: tar -czf data/out.tgz -C data/src .
exec:   tar -tzf data/bundle.tgz                 # list
exec:   tar -xzOf data/bundle.tgz ./one.csv      # one member to stdout
```

## Numbers, time, schemas

### `decimal.js` — arithmetic where rounding must be exact

```js
import Decimal from 'decimal.js'
console.log(JSON.stringify([new Decimal('0.1').plus('0.2').toString(), (0.1 + 0.2).toString()]))
```
```
["0.3","0.30000000000000004"]
```

The second value is what plain JavaScript gives you. Use this for money, and construct
from strings — `new Decimal(0.1)` has already lost the argument.

### `luxon` — dates, zones, intervals

```js
import { DateTime } from 'luxon'
const t = DateTime.fromISO('2026-03-08T01:30', { zone: 'America/New_York' })
console.log(JSON.stringify([t.toISO(), t.plus({ hours: 2 }).toISO()]))
```
```
["2026-03-08T01:30:00.000-05:00","2026-03-08T04:30:00.000-04:00"]
```

Two hours later reads as three, because that clock skipped an hour. Adding time in a zone
is the reason to use this instead of `Date`.

### `ajv` — check JSON against a schema

```js
import Ajv from 'ajv'
const check = new Ajv().compile({ type: 'object', required: ['qty'], properties: { qty: { type: 'integer' } } })
console.log(JSON.stringify(check({ qty: 12 })))
check({ qty: 'twelve' })
console.log(JSON.stringify(check.errors.map(e => e.instancePath + ' ' + e.message)))
```
```
true
["/qty must be integer"]
```

`compile` returns the validator; failures land on `validator.errors` after the call, not
as a return value. Worth pointing at your own output before you call a job done.

## Your own records

### `node:sqlite` — this workspace's `state.sqlite`, in a program

Built into Node, so nothing to install. `$SPORE_SQL` answers one query from the shell; this is
for a program that wants the rows in code. Open it read-only: it is the runtime's, and you
could not write it anyway.

```js
import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('state.sqlite', { readOnly: true })
const turns = db.prepare('SELECT turnNo, stopReason, treeUsd FROM turns ORDER BY turnNo').all()
db.close()
console.log(JSON.stringify(turns))
```
```
[{"turnNo":1,"stopReason":"answer","treeUsd":0.0125},{"turnNo":2,"stopReason":"question","treeUsd":0.003}]
```

The views are `turns`, `inbox`, `transcript`, `events` and `calls`; `reference.md` says what
each holds. A JSON column — a message, a call's `record`, `files` — comes back as text, so
`JSON.parse` it.
