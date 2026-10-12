const { test } = require('node:test')
const assert = require('node:assert/strict')
const ts = require('typescript')
const { readFileSync } = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const file = path.resolve(__dirname, '../src/lib/reference-service-registry.ts')
const mod = new Module(file, module)
mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file)
const { referenceRegistryTotals } = mod.exports

test('canceled reservations never inflate the committed or completed service totals', () => {
  assert.deepEqual(referenceRegistryTotals([
    { service_type: 'FLETE', status: 'RESERVADO', amount_pen: 250 },
    { service_type: 'DESCARGA', status: 'RESERVADO', amount_pen: '50.50' },
    { service_type: 'FLETE', status: 'CONSUMIDO', amount_pen: 200 },
    { service_type: 'FLETE', status: 'LIBERADO', amount_pen: 800 },
  ]), { reserved: 300.5, consumed: 200, released: 800 })
})

test('filtered reference services show only their own financial movements', () => {
  const rows = [
    { reference_type: 'OC', status: 'CONSUMIDO', amount_pen: 500 },
    { reference_type: 'RQ', status: 'RESERVADO', amount_pen: 100 },
  ]
  assert.deepEqual(referenceRegistryTotals(rows.filter(row => row.reference_type === 'RQ')), { reserved: 100, consumed: 0, released: 0 })
  assert.deepEqual(referenceRegistryTotals([]), { reserved: 0, consumed: 0, released: 0 })
})

test('canceling a route retains unloading costs already incurred; only released reservations free amounts', () => {
  assert.deepEqual(referenceRegistryTotals([
    { service_type: 'FLETE', status: 'LIBERADO', stage: 'ANULADO', amount_pen: 800 },
    { service_type: 'DESCARGA', status: 'CONSUMIDO', stage: 'ANULADO', amount_pen: 120 },
    { service_type: 'FLETE', status: 'CONSUMIDO', stage: 'COMPROMETIDO', amount_pen: 200 },
  ]), { reserved: 0, consumed: 320, released: 800 })
})
