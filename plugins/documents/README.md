# @rhizogrip/spore-plugin-documents

Documents for spores: [exceljs](https://github.com/exceljs/exceljs),
[mammoth](https://github.com/mwilliamson/mammoth.js),
[officeparser](https://officeparser.harshankur.com),
[pdf-parse](https://mehmet-kozan.github.io/pdf-parse/) and
[pptxgenjs](https://gitbrent.github.io/PptxGenJS/), importable by the programs an agent writes — to
read xlsx, docx, pptx, odt and PDF, and to write xlsx and pptx.

A plugin for [spore](https://rhizogrip.com); all of them:
[rhizogrip.com/plugins](https://rhizogrip.com/plugins).

```
npm i -g @rhizogrip/spore-plugin-documents
spore plugin allow documents
```

A spore uses it once its `spore.cmk` says `plugins: [documents]`. Its workspace then has each
library under `node_modules/`, which its programs import by name, and `plugins/documents.md`,
one worked example per library. A cell is not given them.

It is a large install: these libraries bring two PDF engines, each with a native canvas, and an
OCR engine.

## License

Apache-2.0
