# documents — `exceljs`, `mammoth`, `officeparser`, `pdf-parse`

Your programs can import these by name, no path, to read the documents work arrives in: xlsx,
docx, pptx, odt and PDF. Run the program with `exec` or `wsexec` like any other. Each example
below is run by the plugin's own tests, against these versions, and the output shown is the
output you get.

A cell is not given them: plugins are the root spore's alone.

### `exceljs` — read and write xlsx

```js
import ExcelJS from 'exceljs'
const wb = new ExcelJS.Workbook()
await wb.xlsx.readFile('data/stock.xlsx')
const rows = []
wb.getWorksheet('data').eachRow(row => rows.push(row.values.slice(1)))
console.log(JSON.stringify(rows))
```
```
[["name","qty"],["bolt",12]]
```

`row.values` is 1-based — index 0 is empty, hence the `slice(1)`. To write, `addWorksheet`,
`addRow`, then `await wb.xlsx.writeFile(path)`.

### `mammoth` — docx to text or HTML

```js
import mammoth from 'mammoth'
const { value, messages } = await mammoth.extractRawText({ path: 'data/report.docx' })
console.log(JSON.stringify({ text: value.trim(), warnings: messages.length }))
```
```
{"text":"Quarterly review","warnings":0}
```

`convertToHtml` and `convertToMarkdown` take the same argument and return the same shape.

### `officeparser` — text out of docx, xlsx, pptx, odt, pdf

```js
import { parseOffice } from 'officeparser'
const doc = await parseOffice('data/stock.xlsx')
console.log(JSON.stringify({ type: doc.type, text: (await doc.to('text')).value.trim() }))
```
```
{"type":"xlsx","text":"name\tqty\nbolt\t12"}
```

It resolves to a document object, not a string — `await doc.to('text')` and take `.value`; a
sheet comes out one row per line, cells separated by tabs. One call handles every format it
knows, which is what to use when you do not know which you were given.

### `pdf-parse` — text out of a PDF

```js
import { readFileSync } from 'node:fs'
import { PDFParse } from 'pdf-parse'
const parser = new PDFParse({ data: new Uint8Array(readFileSync('data/invoice.pdf')) })
const result = await parser.getText()
console.log(JSON.stringify({ pages: result.pages.length, text: result.text.trim() }))
await parser.destroy()
```
```
{"pages":1,"text":"Invoice 42 total 118.30\n\n-- 1 of 1 --"}
```

A class, not a function. The text carries a `-- n of m --` marker between pages; strip it
if you are matching against the content.
