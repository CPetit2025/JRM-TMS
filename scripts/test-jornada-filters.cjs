// Control de Jornada: filtros y orden compartidos por la tabla y por «anterior / siguiente» del detalle (src/lib/jornada.ts).
const assert = require('node:assert/strict')
const ts = require('typescript'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const file = path.resolve(__dirname, '../src/lib/jornada.ts')
const m = new Module(file, module); m.paths = module.paths
m.require = name => name === '@/lib/odometer' ? { formatKm: v => `${v} km` } : require(name)
m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file)
const { applyFilters, filtersFrom, monthWeeks, monthlySummary, rowAlerts } = m.exports
const row = (plate, date, status, extra = {}) => ({ plate, date, status, drivers: ['ANA'], km_odo: null, tn: null, saving: null, refs: { OT: [], OC: [], OS: [], RQ: [] }, ...extra })
const rows = [row('A-1', '2026-10-29', 'CERRADA', { km_odo: 100, refs: { OT: ['16544'], OC: ['57954'], OS: [], RQ: [] } }), row('A-1', '2026-10-30', 'EN_REVISION', { km_odo: 300 }),
 row('B-2', '2026-10-30', 'ABIERTA', { drivers: ['LUIS'] }), row('B-2', '2026-10-28', 'SIN_OPERACION', { drivers: [] })]
const f = q => filtersFrom(new URLSearchParams(q))
const keys = list => list.map(r => `${r.plate}/${r.date}`)
// Sin operación oculta con toda la flota; visible con una unidad o pidiendo ese estado
assert.deepEqual(keys(applyFilters([...rows], f(''))), ['A-1/2026-10-30', 'B-2/2026-10-30', 'A-1/2026-10-29'])
assert.deepEqual(keys(applyFilters([...rows], f('unidad=B-2'))), ['B-2/2026-10-30', 'B-2/2026-10-28'])
assert.deepEqual(keys(applyFilters([...rows], f('estado=SIN_OPERACION'))), ['B-2/2026-10-28'])
// Filtros combinados y búsqueda por OT/OC, conductor o placa; el enlace antiguo ?plate= sigue funcionando
assert.deepEqual(keys(applyFilters([...rows], f('conductor=ANA&q=57954'))), ['A-1/2026-10-29'])
assert.deepEqual(keys(applyFilters([...rows], f('plate=A-1'))), ['A-1/2026-10-30', 'A-1/2026-10-29'])
// Orden por km (desc y asc) y por estado
assert.deepEqual(keys(applyFilters([...rows], f('orden=km:desc'))), ['A-1/2026-10-30', 'A-1/2026-10-29', 'B-2/2026-10-30'])
assert.deepEqual(keys(applyFilters([...rows], f('orden=km:asc'))), ['B-2/2026-10-30', 'A-1/2026-10-29', 'A-1/2026-10-30'])
assert.deepEqual(applyFilters([...rows], f('orden=estado:asc')).map(r => r.status), ['ABIERTA', 'EN_REVISION', 'CERRADA'])

// Reporte mensual: semanas de lunes a domingo recortadas al mes (octubre 2026 empieza en jueves)
assert.deepEqual(monthWeeks('2026-10').map(w => [w.from.slice(8), w.to.slice(8)]), [['01', '04'], ['05', '11'], ['12', '18'], ['19', '25'], ['26', '31']])
const day = (plate, date, status, extra = {}) => ({ ...row(plate, date, status), routes: 1, km_odo: 100, km_gps: 80, tn: 2, tn_apt: 1, cost_total: 50, alerts: [], incidents: [], dispatches: [{ driver: 'ANA', km_real: 100, km_gps: 80 }], saving: { valued: 1, pending: 0, saving: 10 }, ...extra })
const inc = { source: 'EVENTO', id: 'e1', type: 'INCIDENCIA' }
const fleet = { units: [{ plate: 'A-1', type: 'X', status: 'DISPONIBLE', maintenance: [] }, { plate: 'B-2', type: 'X', status: 'DISPONIBLE', maintenance: [{ kind: 'SOLICITUD' }] }, { plate: 'C-3', type: 'X', status: 'FUERA_DE_SERVICIO', maintenance: [] }],
 rows: [day('A-1', '2026-10-02', 'CERRADA'), day('A-1', '2026-10-06', 'CERRADA'), day('B-2', '2026-10-06', 'EN_REVISION', { incidents: [inc], alerts: ['GPS_INCOMPLETO'] }), day('B-2', '2026-10-07', 'ABIERTA', { incidents: [inc] }),
  day('C-3', '2026-10-08', 'SIN_OPERACION', { routes: 0 }), day('A-1', '2026-11-01', 'CERRADA')] }
const sm = monthlySummary(fleet, '2026-10')
assert.deepEqual([sm.totals.routes, sm.weeks.reduce((s2, w) => s2 + w.routes, 0), sm.units.reduce((s2, u) => s2 + u.routes, 0)], [4, 4, 4], 'weeks and units add up to the month (other months excluded)')
assert.deepEqual([sm.totals.activeUnits, sm.totals.availableUnits, sm.totals.incidents, sm.totals.closed, sm.totals.jornadas], [2, 2, 1, 2, 4], 'one incident counted once; C-3 out of service')
assert.deepEqual(sm.units.map(u => [u.plate, u.status]), [['A-1', 'CERRADA'], ['B-2', 'CON_INCIDENCIAS'], ['C-3', 'SIN_OPERACION']])
assert.deepEqual([sm.topKm.plate, sm.topDriver[0], sm.alerts[0][0], sm.alerts[0][1].length], ['A-1', 'ANA', 'GPS_INCOMPLETO', 1])
// Columna Estado: «Sin cierre» lo dice el estado Abierta; checklist con observaciones, fin inferido e incidencias se suman como alertas
assert.deepEqual(rowAlerts({ status: 'ABIERTA', alerts: ['SIN_CIERRE', 'GPS_INCOMPLETO'], operative: true, end_source: null, incidents: [] }).map(a => a.key), ['GPS_INCOMPLETO'])
assert.deepEqual(rowAlerts({ status: 'EN_REVISION', alerts: ['SIN_CIERRE'], operative: false, end_source: 'SIGUIENTE_INICIO', incidents: [inc, inc] }).map(a => a.label),
  ['Sin cierre', 'Checklist con observaciones', 'Odómetro fin inferido (inicio del día siguiente)', '2 incidencia(s)'])
assert.deepEqual(applyFilters([...rows], f('orden=conductor:asc')).map(r => r.drivers[0]), ['ANA', 'ANA', 'LUIS'])
console.log('PASS control de jornada: filtros combinados, sin operación oculta para la flota, búsqueda, enlace ?plate=, orden y resumen mensual (semanas, totales, incidencias, estados)')
