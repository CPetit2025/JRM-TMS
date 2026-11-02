// Control de Jornada: filtros y orden compartidos por la tabla y por «anterior / siguiente» del detalle (src/lib/jornada.ts).
const assert = require('node:assert/strict')
const ts = require('typescript'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const file = path.resolve(__dirname, '../src/lib/jornada.ts')
const m = new Module(file, module); m.paths = module.paths
m.require = name => name === '@/lib/odometer' ? { formatKm: v => `${v} km` } : require(name)
m._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file)
const { applyFilters, filtersFrom } = m.exports
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
console.log('PASS control de jornada: filtros combinados, sin operación oculta para la flota, búsqueda, enlace ?plate= y orden')
