// Catalog/aggregate queries only. GitHub retains ten notices per step: page nine chunks.
const fs = require('node:fs'), zlib = require('node:zlib')
const rows = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (!Array.isArray(rows)) throw new Error('Audit output is not a row array')
const payload = zlib.gzipSync(Buffer.from(JSON.stringify(rows)), { level: 9 }).toString('base64')
const page = Number(process.argv[3] || 0)
if (payload.length > 45 * 3000) {
  // The query has already completed. Large catalogs belong in the full JSON artifact;
  // publishing a truncated gzip stream would produce unusable evidence.
  if (Number(process.argv[3] || 0) === 0) console.log(`::warning title=Audit publication capacity::Full audit (${rows.length} records) exceeds annotation capacity. Consult the complete read-only-audit artifact; no partial payload is published.`)
  process.exit(0)
}
for (let part = page * 9; part < Math.min((page + 1) * 9, Math.ceil(payload.length / 3000)); part++) {
  console.log(`::notice title=Security payload ${part + 1}::${payload.slice(part * 3000, (part + 1) * 3000)}`)
}
console.log(`Reviewed metadata records: ${rows.length}; total payload chunks: ${Math.ceil(payload.length / 3000)}`)
