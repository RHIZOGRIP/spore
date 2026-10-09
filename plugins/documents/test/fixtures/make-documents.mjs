/**
 * The documents the examples in reference.md read. Built rather than committed, so the
 * fixtures cannot go stale against the libraries that produced them — and building them
 * is itself a check that the write side works.
 */
import { writeFileSync } from 'node:fs'
import { strToU8, zipSync } from 'fflate'
import ExcelJS from 'exceljs'

const XML = 'http://schemas.openxmlformats.org'
writeFileSync('data/report.docx', zipSync({
  '[Content_Types].xml': strToU8(`<?xml version="1.0"?><Types xmlns="${XML}/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
  '_rels/.rels': strToU8(`<?xml version="1.0"?><Relationships xmlns="${XML}/package/2006/relationships"><Relationship Id="rId1" Type="${XML}/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
  'word/document.xml': strToU8(`<?xml version="1.0"?><w:document xmlns:w="${XML}/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Quarterly review</w:t></w:r></w:p></w:body></w:document>`)
}))

const wb = new ExcelJS.Workbook()
const sheet = wb.addWorksheet('data')
sheet.addRow(['name', 'qty'])
sheet.addRow(['bolt', 12])
await wb.xlsx.writeFile('data/stock.xlsx')

// Uncompressed by hand: no library here writes a PDF, and a committed binary would be a
// fixture nothing in the repo could regenerate.
const objects = [
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n',
  '4 0 obj<</Length 52>>stream\nBT /F1 12 Tf 20 50 Td (Invoice 42 total 118.30) Tj ET\nendstream endobj\n',
  '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n'
]
let pdf = '%PDF-1.4\n'
const offsets = []
for (const object of objects) {
  offsets.push(pdf.length)
  pdf += object
}
const startxref = pdf.length
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
  offsets.map(at => String(at).padStart(10, '0') + ' 00000 n \n').join('') +
  `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${startxref}\n%%EOF\n`
writeFileSync('data/invoice.pdf', pdf, 'latin1')
