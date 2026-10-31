// Reglas puras del armado de ruta (src/components/despacho/programar-ruta/route-checks.ts): salida después de la
// atención requerida, ventanas de atención, avance por etapas y uso de capacidad.
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), ts = require('typescript'), Module = require('node:module')
const file = path.resolve(__dirname, '../src/components/despacho/programar-ruta/route-checks.ts')
const m = new Module(file, module)
m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file)
const { lateStops, windowEnd, collectChecks, firstBlockedStep, blocking, capacityPct } = m.exports

test('departure after the required attention is detected by exact time, day and time window', () => {
 const stops = [
  { request_number: 'A', required_at: '2026-10-31T15:00:00Z' },            // 10:00 Lima
  { request_number: 'B', required_date: '2026-10-31' },
  { request_number: 'C', required_date: '2026-10-31', time_window: '08:00 - 12:00' },
  { request_number: 'D', required_date: '2026-11-01' },
 ]
 assert.deepEqual(lateStops(stops, '2026-10-31T09:00').map(r => r.request_number), [])
 assert.deepEqual(lateStops(stops, '2026-10-31T11:00').map(r => r.request_number), ['A'])
 assert.deepEqual(lateStops(stops, '2026-10-31T12:30').map(r => r.request_number), ['A', 'C'])
 assert.deepEqual(lateStops(stops, '2026-11-01T08:00').map(r => r.request_number), ['A', 'B', 'C'])
 assert.deepEqual(lateStops(stops, ''), [])
})

test('time windows are read in the usual formats', () => {
 assert.equal(windowEnd('08:00 - 12:00'), '12:00')
 assert.equal(windowEnd('8:00 a 9:30'), '09:30')
 assert.equal(windowEnd('Mañana'), null)
 assert.equal(windowEnd(null), null)
})

test('advancing stops at the first step with a blocking check; warnings never block', () => {
 const checks = collectChecks([
  false,
  { key: 'stock', label: 'Stock desactualizado', step: 1, level: 'warn' },
  { key: 'placa', label: 'Placa', step: 2, level: 'block' },
  { key: 'salida', label: 'Salida', step: 4, level: 'block' },
  null,
 ])
 assert.equal(checks.length, 3)
 assert.equal(firstBlockedStep(checks, 1), null, 'a warning on step 1 lets the user continue')
 assert.equal(firstBlockedStep(checks, 3), 2)
 assert.equal(firstBlockedStep(checks, 5), 2)
 assert.deepEqual(blocking(checks, 4).map(c => c.key), ['salida'])
 assert.equal(blocking(checks).length, 2)
})

test('capacity use is unknown without a registered capacity', () => {
 assert.equal(capacityPct(3050, 7500).toFixed(1), '40.7')
 assert.equal(capacityPct(100, null), null)
 assert.equal(capacityPct(100, 0), null)
})
