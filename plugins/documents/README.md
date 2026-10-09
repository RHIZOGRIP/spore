# @rhizogrip/spore-plugin-documents

Documents for spores: [exceljs](https://github.com/exceljs/exceljs),
[mammoth](https://github.com/mwilliamson/mammoth.js),
[officeparser](https://officeparser.harshankur.com) and
[pdf-parse](https://mehmet-kozan.github.io/pdf-parse/), importable by the programs an agent writes —
xlsx, docx, pptx, odt and PDF.

```
npm i -g @rhizogrip/spore-plugin-documents
spore plugin allow documents
```

A spore uses it once its `spore.cmk` says `plugins: [documents]`. Its workspace then has each
library under `node_modules/`, which its programs import by name, and `plugins/documents.md`,
one worked example per library. A cell is not given them.

It is apart from spore because it is most of what an install weighs: two PDF engines, each with
a native canvas, and an OCR engine come with these libraries.

## License

Apache-2.0
