// Torre de Control · liquidación documentaria del viaje (reingeniería, Fase 5): toma el viaje de la bandeja documentaria
// (consulta por período del día del viaje), arma los servicios con su lista de la base y aplica los mismos permisos
// que la bandeja (no se liquida un viaje ya liquidado); sin el viaje en la bandeja, avisa en lugar de mostrar vacío.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript'), React = require('react')
const { create, act } = require('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT = true
global.window = { setTimeout, clearTimeout, open() {} }
let queue = [], props = null
const calls = []
const client = {
 rpc: async (name, args) => { calls.push({ name, args })
  return name === 'get_documentary_queue_period' ? { data: queue, error: null }
   : name === 'get_settlement_checklists' ? { data: [{ dispatch_id: 'd1', request_id: 'r1', kind: 'RECOJO', complete: false, missing: ['GUIA'] }], error: null }
   : { data: [], error: null } },
 from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { scheduled_departure: '2026-10-30T13:00:00Z' } }) }) }) }),
}
function load(file) {
 const filename = path.resolve(__dirname, '..', file)
 const m = new Module(filename, module); m.paths = module.paths
 m.require = name => {
  if (name === '@/lib/supabase/client') return { createClient: () => client }
  if (name === '@/hooks/usePermissions') return { usePermissions: () => ({ canWrite: () => true, canRead: () => true, role: 'jefe de distribución', isLoaded: true }) }
  if (name === '@/lib/request-service') return { fetchServiceTypes: async () => new Map() }
  if (name === '@/components/documentos/GuidesClosureTab') return {
   GuidesClosureTab: p => { props = p; return React.createElement('div', { 'data-guides': p.stops.length }) },
   NOT_SETTLEABLE: ['PROGRAMADO', 'CANCELADO', 'CERRADO'], settlementKind: () => 'ENTREGA', knownNumbers: () => [] }
  if (name === '@/components/delivery/DeliveryReview') return { DeliveryReview: () => null }
  if (name === '@/components/despacho/DocumentNumberLinks') return { DocumentNumberLinks: () => null }
  if (name === '@/lib/caja') return { DOCS_BUCKET: 'docs', errorMessage: e => String(e?.message || e), receiptUrl: async () => null }
  if (name === '@/lib/suppliers') return { referenceLabel: () => null }
  if (name === 'sonner') return { toast: { error() {}, success() {} } }
  return require(name)
 }
 m._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename)
 return m.exports
}
const { DispatchDocumentarySettlement } = load('src/components/documentos/DispatchDocumentarySettlement.tsx')
const stop = (id, ot) => ({ request_id: id, request_number: 'S-' + id, ot_code: ot, client: 'Cliente', delivery: 'Lima', sequence: 1 })
const render = async (extra = {}) => { let r; await act(async () => { r = create(React.createElement(DispatchDocumentarySettlement, { dispatchId: 'd1', ...extra })) }); await act(async () => { await new Promise(res => setTimeout(res, 5)) }); return r }

test('toma el viaje de la bandeja y arma sus servicios con la lista de la base', async () => {
 queue = [{ id: 'd0', status: 'CIERRE_OPERATIVO', is_pickup: false, stops: [stop('r0', 'X')], documents: [] },
  { id: 'd1', status: 'CIERRE_OPERATIVO', is_pickup: false, stops: [stop('r1', 'OT-9'), stop('r2', null)], documents: [] }]
 props = null; calls.length = 0
 await render()
 const q = calls.find(c => c.name === 'get_documentary_queue_period')
 assert.deepEqual([q.args.p_include_departed, q.args.p_from.slice(0, 10), q.args.p_until.slice(0, 10)], [true, '2026-10-29', '2026-10-31'], 'el día del viaje ±1')
 assert.equal(props.dispatchId, 'd1')
 assert.deepEqual(props.stops.map(s => [s.request_id, s.ot, s.kind]), [['r1', 'OT OT-9', 'RECOJO'], ['r2', 'Sin referencia', 'ENTREGA']])
 assert.deepEqual([props.canUpload, props.canManual, props.executed, props.canVoid], [true, true, true, false])
})

test('con la ruta cerrada (LIQUIDADO) se liquida; con cierre final vigente solo se consulta', async () => {
 queue = [{ id: 'd1', status: 'LIQUIDADO', is_pickup: false, stops: [stop('r1', 'OT-9')], documents: [] }]
 props = null
 await render()
 assert.deepEqual([props.canUpload, props.canManual], [true, true])
 props = null
 await render({ finalClosed: true })
 assert.deepEqual([props.canUpload, props.canManual], [false, false])
})

test('sin el viaje en la bandeja avisa en lugar de mostrar una lista vacía', async () => {
 queue = []; props = null
 const r = await render()
 assert.equal(props, null)
 assert.ok(JSON.stringify(r.toJSON()).includes('no está disponible'))
})
