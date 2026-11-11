// Lógica del banner de actualización (mismo archivo en TMS y WMS).
const assert = require('node:assert/strict'), fs = require('node:fs'), ts = require('typescript')
const m = { exports: {} }
new Function('exports', 'module', ts.transpileModule(fs.readFileSync('src/lib/update-status.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(m.exports, m)
const { nextErpRun, lastErpSlot, erpState, ingresosState, since, until } = m.exports
const lima = s => new Date(`${s}-05:00`), iso = s => lima(s).toISOString()
// Horario del ERP en hora de Lima
assert.equal(nextErpRun(lima('2026-11-10T09:30')).toISOString(), iso('2026-11-10T10:00'))
assert.equal(nextErpRun(lima('2026-11-10T19:01')).toISOString(), iso('2026-11-11T07:00'), 'después de las 19 h: mañana 07 h')
assert.equal(lastErpSlot(lima('2026-11-10T06:00')).toISOString(), iso('2026-11-09T19:00'), 'antes de las 07 h: la de ayer 19 h')
// ERP
const now = lima('2026-11-10T11:00')
assert.equal(erpState({ stock_at: iso('2026-11-10T10:10'), contratos_at: iso('2026-11-10T10:06') }, now).level, 'ok')
assert.equal(erpState({ stock_at: iso('2026-11-10T10:10'), contratos_at: iso('2026-11-08T16:12') }, now).level, 'late', 'cuenta la carga más antigua')
assert.equal(erpState({ stock_at: iso('2026-11-10T07:10'), contratos_at: iso('2026-11-10T07:06') }, lima('2026-11-10T10:20')).level, 'ok', 'dentro del margen de la carga de las 10 h')
assert.equal(erpState({ stock_at: iso('2026-11-10T07:10'), contratos_at: iso('2026-11-10T07:06') }, lima('2026-11-10T10:45')).level, 'late', 'la carga de las 10 h no llegó')
assert.equal(erpState({ stock_at: iso('2026-11-10T10:10'), contratos_at: iso('2026-11-08T16:12') }, lima('2026-11-10T13:20')).level, 'late', 'datos de hace 2 días: atraso aunque la carga de las 13 h siga en curso')
assert.equal(erpState({ stock_at: iso('2026-11-10T07:10'), contratos_at: iso('2026-11-10T07:06'), loading_since: iso('2026-11-10T10:17') }, lima('2026-11-10T10:25')).level, 'running')
assert.equal(erpState({ stock_at: iso('2026-11-10T07:10'), contratos_at: iso('2026-11-10T07:06'), loading_since: iso('2026-11-10T10:17') }, now).level, 'error', 'carga trabada más de 30 min')
assert.equal(erpState({ stock_at: iso('2026-11-10T10:10'), contratos_at: iso('2026-11-10T10:06'), request: { status: 'PENDING' } }, now).detail, 'Solicitud en cola')
assert.equal(erpState({ stock_at: iso('2026-11-10T10:10'), contratos_at: iso('2026-11-10T10:06'), request: { status: 'ERROR', finished_at: iso('2026-11-10T10:40'), message: 'Excel no respondió' } }, now).level, 'error')
assert.equal(erpState({ stock_at: iso('2026-11-10T10:10'), contratos_at: iso('2026-11-10T10:06'), request: { status: 'RUNNING', started_at: iso('2026-11-10T09:30') } }, now).level, 'error', 'solicitud trabada no queda en curso para siempre')
assert.equal(erpState({ stock_at: iso('2026-11-10T10:10'), contratos_at: iso('2026-11-10T10:06'), request: { status: 'PENDING', requested_at: iso('2026-11-10T10:45') } }, now).level, 'error', 'solicitud que el robot no toma en 10 min')
// Ingresos
assert.equal(ingresosState({ last_ok_at: iso('2026-11-10T10:57'), last_auto_at: iso('2026-11-10T10:57') }, now).level, 'ok')
assert.equal(ingresosState({ last_ok_at: iso('2026-11-10T10:57'), last_auto_at: iso('2026-11-10T10:57') }, now).nextAt.toISOString(), iso('2026-11-10T11:02')) // robot cada 5 min
assert.equal(ingresosState({ last_ok_at: iso('2026-11-10T10:00') }, now).level, 'late') // más de 15 min sin actualizar
assert.equal(ingresosState({ last_ok_at: iso('2026-11-10T10:00'), last_error_at: iso('2026-11-10T10:30') }, now).level, 'error')
assert.equal(ingresosState({ last_ok_at: iso('2026-11-10T10:40'), pending: true }, now).level, 'running')
// Textos
assert.equal(since(lima('2026-11-10T10:35'), now), 'hace 25 min'); assert.equal(since(lima('2026-11-08T11:00'), now), 'hace 2 d')
assert.equal(until(lima('2026-11-10T11:25'), now), 'en 25 min')
console.log('PASS: banner de actualización: horario del ERP en Lima, atraso, en curso, error y textos.')
