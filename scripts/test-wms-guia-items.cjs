// Guía de carga: ítem tomado del código de OT/contrato y consolidado por ítem + código + lote.
const assert = require('node:assert/strict'), ts = require('typescript'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const file = path.resolve('src/lib/warehouse/packing-list.ts'), m = new Module(file, module)
m.paths = module.paths; m.require = n => n === '@/components/warehouse/Code128Barcode' ? { code128Bars: () => [] } : require(n)
m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: 1, target: 9 } }).outputText, file)
const { itemOf, consolidateItems } = m.exports
assert.equal(itemOf('16571-S001-069'), '069'); assert.equal(itemOf('16571-069'), '069'); assert.equal(itemOf('16571'), null); assert.equal(itemOf(null), null)
const p = (c, code, lot, q, kg) => ({ package_code: 'x', product_code: code, description: 'd', lot, contract_code: c, quantity: q, unit: 'UND', weight_kg: kg })
const lines = consolidateItems([{ packages: [p('16571-S001-069', 'A', 'L1', 2, 10), p('16571-069', 'A', 'L1', 3, 15), p('16571-S001-069', 'A', 'L2', 1, 5)] }, { packages: [p('16571-S001-012', 'B', 'L1', 4, 8)] }])
assert.deepEqual(lines.map(l => [l.item, l.product_code, l.lot, l.packages, l.quantity, l.weight_kg]),
  [['012', 'B', 'L1', 1, 4, 8], ['069', 'A', 'L1', 2, 5, 25], ['069', 'A', 'L2', 1, 1, 5]], 'mismo ítem, código y lote se suman; otro lote va aparte')
console.log('PASS: guía de carga consolidada por ítem (069 de 16571-S001-069 o 16571-069), código de producto y lote.')
