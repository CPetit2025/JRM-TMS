// Etiqueta del LPN: muestra el ítem (OT/contrato completo) solo si todo el LPN es del mismo ítem, producto y lote;
// un LPN multiproducto muestra solo el lote.
const assert = require('node:assert/strict'), ts = require('typescript'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const file = path.resolve('src/lib/warehouse/receipt-lpn.ts'), m = new Module(file, module); m.paths = module.paths
m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: 1, target: 9 } }).outputText, file)
const { lpnLabelData } = m.exports
const p = (contract, product, lot) => ({ contract_code: contract, product_code: product, lot, document: 'IPT-1', quantity: 1, unit: 'UND', weight_kg: 1, warehouse: 'APT', date: '2026-11-13', receipt_key: product })
const lpn = packages => ({ id: 'l', lpn_code: '16571-S002-B-0009', origin: 'RECEPCION', status: 'CLOSED', task_id: null, print_count: 0, package_count: packages.length, quantity: packages.length, weight_kg: packages.length, created_at: '', created_by_name: null, packages })
assert.equal(lpnLabelData(lpn([p('16571-S002-022', 'A', '16571-S002'), p('16571-S002-022', 'A', '16571-S002')]), null).contract_code, '16571-S002-022', 'mismo ítem, producto y lote: muestra el ítem')
assert.equal(lpnLabelData(lpn([p('16571-S002-022', 'A', '16571-S002'), p('16571-S002-024', 'B', '16571-S002')]), null).contract_code, '16571-S002', 'multiproducto: solo el lote')
{const l = lpnLabelData(lpn([p('16571-S002-022', 'A', '16571-S002'), p('16571-S001-069', 'C', '16571-S001')]), null)
 assert.deepEqual([l.contract_code, l.source_lot, l.description], ['', 'VER DETALLE', ''], 'varios lotes: OT vacía, lote «VER DETALLE», sin línea de contenido')}
console.log('PASS: etiqueta del LPN con ítem solo si es el mismo ítem, producto y lote; multiproducto muestra el lote.')
