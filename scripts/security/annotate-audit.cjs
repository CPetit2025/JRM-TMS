// Only receives reviewed catalog/aggregate queries; never prints credential environment variables.
const fs = require('node:fs')
const raw = fs.readFileSync(process.argv[2], 'utf8')
let rows
try { rows = JSON.parse(raw) } catch { throw new Error('Audit output is not valid JSON') }
if (!Array.isArray(rows)) throw new Error('Audit output is not a row array')
let chunk = [], size = 0, part = 0
function flush() {
  if (!chunk.length) return
  const message = JSON.stringify(chunk).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
  console.log(`::notice title=Security catalog ${++part}::${message}`)
  chunk = []; size = 0
}
for (const row of rows) {
  const len = JSON.stringify(row).length
  if (size + len > 3000) flush()
  chunk.push(row); size += len
}
flush()
console.log(`Reviewed metadata records: ${rows.length}`)
