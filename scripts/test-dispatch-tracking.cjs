const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const ts = require('typescript')

const source = fs.readFileSync(path.join(__dirname, '../src/lib/dispatch-tracking.ts'), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
const loaded = new Module(path.join(__dirname, 'dispatch-tracking.test.js'), module)
loaded.filename = path.join(__dirname, 'dispatch-tracking.test.js')
loaded.paths = module.paths
loaded._compile(compiled, loaded.filename)
const { buildDispatchDashboard, trackingRange } = loaded.exports

assert.deepEqual(trackingRange('DIA', '2026-10-31'), { from: '2026-10-31', to: '2026-10-31' })
assert.deepEqual(trackingRange('SEMANA', '2026-11-04'), { from: '2026-11-02', to: '2026-11-08' })
assert.deepEqual(trackingRange('MES', '2026-02-12'), { from: '2026-02-01', to: '2026-02-28' })

const portal = (overrides = {}) => ({ dispatch_id: 'd1', dispatch_number: '101', request_id: 'r1', request_number: 'RT-1', scheduled_departure: '2026-10-31T10:00:00-05:00', state: 'ENTREGADO', dispatch_status: 'ENTREGADO', driver_name: 'Ana', plate: 'ABC-123', modalidad: 'PROPIA', ot_code: 'OT-10', reference_type: 'OC', reference_number: 'OC-90', supplier_name: 'Proveedor', client_name: 'Cliente', pickup_address: 'Origen', delivery_address: 'Destino', guide_number: 'G1', ...overrides })
const report = { plate: 'ABC-123', days: [{ date: '2026-10-31', drivers: ['Ana'], checklists: 1, operative: true, odo_start: 39251, odo_end: 39427, km_odo: 176, km_gps: 0, routes: 2, services: 2, tn: 0, readings: [], alerts: ['GPS_INCOMPLETO'], dispatches: [
  { dispatch_number: '101', status: 'ENTREGADO', driver: 'Ana', modalidad: 'PROPIA', departure: '2026-10-31T10:00:00-05:00', km_gps: 0, km_real: 90, km_real_source: 'ODOMETRO', odo_start: 39251, odo_end: 39341, costs: [], stops: [{ request_number: 'RT-1', sequence: 1, status: 'ENTREGADO', type: 'Entrega', ot: 'OT-10', ref_type: 'OC', ref_number: 'OC-90', reference_supplier: 'Proveedor', client: 'Cliente', origin: 'Origen', destination: 'Destino', km_leg: 80, km_source: 'ODOMETRO', odo_reading: 39300, odo_photo: 'evidence/a.jpg', kg: 1000 }] },
  { dispatch_number: '102', status: 'EN_CURSO', driver: 'Ana', modalidad: 'PROPIA', departure: '2026-10-31T12:00:00-05:00', km_gps: 0, km_real: null, km_real_source: null, costs: [], stops: [{ request_number: 'RT-2', status: 'EN_CURSO', ot: 'OT-11', km_leg: 10, km_source: 'GPS_PARCIAL' }] },
] }] }
const result = buildDispatchDashboard([portal(), portal({ dispatch_id: 'd2', dispatch_number: '102', request_id: 'r2', request_number: 'RT-2', state: 'EN_CURSO', dispatch_status: 'EN_CURSO', scheduled_departure: '2026-10-31T12:00:00-05:00' })], [report], { from: '2026-10-31', to: '2026-10-31' })

assert.equal(result.groups.length, 1, 'routes group under the same day and driver')
assert.equal(result.groups[0].routes.length, 2, 'both dispatches remain visible')
assert.equal(result.groups[0].serviceCount, 2, 'each service is counted once')
assert.equal(result.groups[0].kmOdo, 176, 'driver row does not duplicate vehicle daily odometer')
assert.equal(result.groups[0].kmGps, 0, 'GPS stays separate from odometer kilometers')
assert.equal(result.groups[0].stops.length, 2, 'service detail combines report and tracking portal')
assert.equal(result.groups[0].alerts.has('GPS_INCOMPLETO'), true, 'vehicle alerts remain visible')
assert.deepEqual(result.totals, { dispatches: 2, routes: 2, services: 2, kmOdo: 176, delivered: 1, inProgress: 1 })

const sharedUnit = buildDispatchDashboard([], [report, { plate: 'XYZ-001', days: [{ ...report.days[0], dispatches: [], routes: 0, drivers: ['Luis'] }] }], { from: '2026-10-31', to: '2026-10-31' })
assert.equal(sharedUnit.totals.kmOdo, 352, 'unique unit/day readings aggregate once per unit, not once per driver row')
console.log('PASS: day/week/month ranges, route and service deduplication, odometer/GPS separation, driver grouping and checklist alerts.')
