// Modal «Detalle del despacho»: pestañas con datos reales, GPS solo con conexión confirmada, «Validar conformidad»
// solo con guía recibida, «Finalizar» solo cierra, historial filtrable y el portal público conserva su detalle simple.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript'), React = require('react')
const { create, act } = require('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT = true
const noop = () => {}
global.document = { addEventListener: noop, removeEventListener: noop, body: { style: {} }, getElementById: () => null }
global.window = { setTimeout, clearTimeout }
const cache = new Map(), calls = []
let detail, files, econ, expenses = { data: [], error: null }, track = { data: [], error: null }
const query = { select: () => query, eq: () => query, order: () => Object.assign(Promise.resolve(expenses), { limit: async () => track }), maybeSingle: async () => ({ data: { programming_notes: null }, error: null }) }
const client = {
 rpc: async (name, args) => { calls.push({ name, args }); return name === 'get_dispatch_detail' ? { data: detail, error: null } : name === 'get_dispatch_detail_files' ? { data: files, error: null } : name === 'economic_closure_detail' ? { data: econ, error: null }
  : name === 'get_dispatch_evidence' ? { data: [{ kind: 'CHECKLIST', label: 'Checklist de la unidad', path: 'u/check.jpg', taken_at: '2026-10-30T20:50:00Z' }], error: null } : { data: { success: true, people: [], manual_closure: null }, error: null } },
 storage: { from: bucket => ({ createSignedUrl: async path => ({ data: { signedUrl: `https://x.supabase.co/storage/v1/object/sign/${bucket}/${path}?token=t` } }) }) },
 from: () => query,
}
function load(file) {
 const filename = path.resolve(__dirname, '..', file)
 if (cache.has(filename)) return cache.get(filename)
 const m = new Module(filename, module); m.paths = module.paths
 m.require = name => {
  if (name === '@/lib/supabase/client') return { createClient: () => client }
  if (name === '@/hooks/usePermissions') return { usePermissions: () => ({ canWrite: () => true }) }
  if (name === '@/components/ui/modal') return { Modal: ({ isOpen, title, children, footer }) => isOpen ? React.createElement('div', { 'aria-label': title }, children, footer) : null }
  if (name === '@/components/ui/data-table') return { DataTable: ({ children, ...props }) => React.createElement('table', props, children) }
  if (name === 'react-dom') return { ...require('react-dom'), createPortal: node => node }
  if (name === 'sonner') return { toast: { error() {}, success() {} } }
  if (name === 'next/dynamic') return { __esModule: true, default: () => ({ points, planned }) => React.createElement('div', { 'data-map-points': points.length, 'data-planned': planned ? planned.length : 0 }) }
  if (name === 'next/link') return { __esModule: true, default: ({ href, children, ...props }) => React.createElement('a', { href, ...props }, children) }
  if (name.startsWith('@/') || name.startsWith('.')) {
   const base = name.startsWith('@/') ? path.resolve(__dirname, '../src', name.slice(2)) : path.resolve(path.dirname(filename), name)
   const found = ['.ts', '.tsx'].map(ext => base + ext).find(fs.existsSync)
   if (found) return load(path.relative(path.resolve(__dirname, '..'), found))
  }
  return require(name)
 }
 m._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename)
 cache.set(filename, m.exports); return m.exports
}
const { DispatchDetailModal } = load('src/components/despacho/detalle/DispatchDetailModal.tsx')
const { DeliveryTable } = load('src/components/delivery/DeliveryTable.tsx')
const lib = load('src/lib/dispatch-detail.ts')
const row = (over = {}) => ({ dispatch_id: 'd1', request_id: 's1', dispatch_number: '10103', request_number: 'RT-002314', ot_code: 'Sin OT vinculada', client_name: null, supplier_name: 'Cajahuaringa', request_type: 'RECOJO',
 pickup_address: 'Av. Las Amapolas, Manchay', delivery_address: 'Planta Chilca', plate: 'BDK791', driver_name: 'Ivan Salazar', carrier_name: null, modalidad: 'PROPIA', scheduled_departure: '2026-10-30T21:00:00Z',
 guide_number: 'T002-4165', conformity: 'RECIBIDA', documents_state: 'NO_REQUERIDO', submission_id: 'x', photos_count: 1, submitted_at: null, arrived_at: '2026-10-30T22:51:00Z', state: 'RECIBIDA',
 last_event_at: '2026-10-30T22:52:00Z', gps_at: null, events: [], ...over })
const filesBase = () => ({ can_view_documents: true, sources_failed: [], references: [{ doc_type: 'GR', number: 'T001-77', at: '2026-10-30T20:10:00Z', by: 'Ana' }],
 documents: [{ id: 'doc1', doc_type: 'GUIA_REMISION', category: null, number: 'T001-77', file_path: 'd1/gr.pdf', file_name: 'gr.pdf', mime_type: 'application/pdf', size_bytes: 250000, uploaded_at: '2026-10-30T20:00:00Z', uploaded_by: 'Ana Torre', scope: 'SERVICIO' }],
 documentary: { status: 'EN_VALIDACION', source: null, missing: ['CONFORMIDAD'], completed_at: null, completed_by: null, reopened_at: null, updated_at: '2026-10-30T23:00:00Z' },
 submissions: [{ id: 'sub1', photos: ['s/a.jpg', 's/b.jpg'], packing_photos: ['s/p.jpg'], guide_number: 'T002-4165', received_by: 'Portería', source: 'APP', captured_at: '2026-10-30T22:50:00Z', submitted_at: '2026-10-30T22:52:00Z', submitted_by: 'Ivan Salazar', review: null }],
 arrival: null, rejection: null })
const base = (over = {}) => ({
 dispatch: { id: 'd1', number: '10103', status: 'EN RUTA', modalidad: null, scheduled_departure: '2026-10-30T21:00:00Z', estimated_distance_km: 72, vehicle_plate: 'BDK791', services_count: 1, driver: { name: 'Ivan Salazar', document_number: '45832165' } },
 milestones: { programado: '2026-10-30T21:00:00Z', salida: '2026-10-30T21:25:00Z', llegada: '2026-10-30T22:51:00Z', conformidad: null, rechazo: null, retorno: null, cierre: null, cierre_estado: null },
 presence: { applies: true, connected: false, last_seen_at: '2026-10-30T22:00:00Z', gps_state: 'active', gps_at: '2026-10-30T22:52:00Z', server_now: '2026-10-30T23:00:00Z' },
 events: [
  { at: '2026-10-30T22:52:00Z', source: 'ENTREGA', scope: 'SERVICIO', type: 'GUIA_RECIBIDA', detail: 'Guía T002-4165', actor: 'Ivan Salazar', level: 'INFO' },
  { at: '2026-10-30T22:40:00Z', source: 'OPERACION', scope: 'RUTA', type: 'RETRASO', detail: 'Tráfico', actor: 'Monitoreo', level: 'INCIDENCIA' },
 ], economic: false, sources_failed: [], ...over })
const flush = () => new Promise(resolve => setTimeout(resolve, 15))
const flat = node => node == null ? '' : typeof node === 'string' ? node : Array.isArray(node) ? node.map(flat).join('') : flat(node.children)
const text = view => flat(view.toJSON())
const itext = inst => inst.children.map(c => typeof c === 'string' ? c : itext(c)).join('')
const button = (view, label) => view.root.findAllByType('button').find(b => itext(b).includes(label))
const tab = (view, label) => view.root.findAllByProps({ role: 'tab' }).find(b => b.props.children.includes(label))

test('tabs load the stop detail once and show real milestones, GPS and incidents', async () => {
 calls.length = 0; detail = base(); let view, closed = 0, validated = null
 await act(async () => { view = create(React.createElement(DispatchDetailModal, { row: row(), onClose: () => closed++, onValidate: r => { validated = r } })) }); await act(flush)
 assert.deepEqual(calls.filter(c => c.name === 'get_dispatch_detail').map(c => c.args), [{ p_dispatch: 'd1', p_request: 's1' }])
 assert.ok(view.root.findByProps({ 'aria-label': 'Detalle del despacho 10103 · RT-002314' }))
 assert.deepEqual(view.root.findAllByProps({ role: 'tab' }).map(t => t.props.children[1]), ['Resumen', 'Ruta y seguimiento', 'Documentos', 'Fotos y evidencias', 'Costos', 'Historial'])
 assert.ok(!calls.some(c => c.name === 'get_dispatch_detail_files'), 'files load only when their tab opens')
 assert.ok(text(view).includes('45832165')); assert.ok(text(view).includes('Guía de entrega pendiente de validación'))
 await act(async () => button(view, 'Validar conformidad').props.onClick()); assert.equal(validated.request_id, 's1')
 await act(async () => tab(view, 'Ruta y seguimiento').props.onClick())
 assert.ok(text(view).includes('Sin conexión'), 'stale presence is offline'); assert.ok(!text(view).includes('En línea'))
 assert.ok(text(view).includes('Tráfico')); assert.ok(text(view).includes('72 km'))
 assert.ok(text(view).includes('Sin estimar'), 'no invented estimated time')
 for (let i = 0; i < 4; i++) { await act(async () => button(view, 'Siguiente').props.onClick()); await act(flush) }
 assert.ok(!button(view, 'Siguiente')); await act(async () => button(view, 'Finalizar').props.onClick()); assert.equal(closed, 1, 'Finalizar only closes')
 assert.deepEqual(calls.filter(c => !['get_dispatch_detail', 'get_tower_route_crew', 'get_dispatch_detail_files', 'get_dispatch_evidence', 'economic_closure_detail'].includes(c.name)), [], 'only reads')
 await act(async () => view.unmount())
})

test('validation is only offered for a received guide; third-party units have no GPS', async () => {
 detail = base({ presence: { applies: false, connected: false, last_seen_at: null, gps_state: null, gps_at: null, server_now: '2026-10-30T23:00:00Z' } }); let view
 await act(async () => { view = create(React.createElement(DispatchDetailModal, { row: row({ conformity: 'VALIDADA', modalidad: 'TERCERO' }), onClose() {}, onValidate() {} })) }); await act(flush)
 assert.equal(button(view, 'Validar conformidad'), undefined)
 await act(async () => tab(view, 'Ruta y seguimiento').props.onClick())
 assert.ok(text(view).includes('Unidad de tercero: sin GPS del app'))
 await act(async () => view.unmount())
})

test('documents and evidence come from real sources, sign their files and offer no deletion', async () => {
 calls.length = 0; detail = base(); files = filesBase(); let view
 await act(async () => { view = create(React.createElement(DispatchDetailModal, { row: row(), onClose() {}, documentsHref: '/despacho/documentos?despacho=d1' })) }); await act(flush)
 await act(async () => tab(view, 'Documentos').props.onClick()); await act(flush)
 assert.equal(calls.filter(c => c.name === 'get_dispatch_detail_files').length, 1)
 assert.ok(text(view).includes('Ana Torre')); assert.ok(text(view).includes('Checklist de conformidad')); assert.ok(text(view).includes('Conformidad de recepción'))
 assert.ok(!view.root.findAllByType('input').some(i => i.props.type === 'checkbox'), 'checklist is read-only')
 await act(async () => view.root.findAllByProps({ 'aria-label': 'Ver Guía de remisión' })[0].props.onClick())
 assert.ok(view.root.findAllByType('iframe')[0].props.src.includes('dispatch_documents/d1/gr.pdf'), 'pdf preview from a signed url')
 assert.ok(view.root.findAllByType('a').some(a => a.props.href === '/despacho/documentos?despacho=d1'), 'add document opens the real flow')
 await act(async () => tab(view, 'Fotos y evidencias').props.onClick()); await act(flush)
 assert.equal(calls.filter(c => c.name === 'get_dispatch_detail_files').length, 1, 'files are not reloaded between tabs')
 assert.ok(text(view).includes('Todas (4)')); assert.ok(text(view).includes('Llegada (2)')); assert.ok(text(view).includes('Descarga (1)')); assert.ok(text(view).includes('Unidad (1)'))
 assert.ok(text(view).includes('Recojo (0)') && text(view).includes('Tránsito (0)'), 'stages without records count zero')
 assert.ok(!button(view, 'Agregar evidencia'), 'no upload without operating permission')
 assert.ok(!text(view).includes('Eliminar'), 'evidence is never deleted here')
 assert.ok(view.root.findAllByType('a').some(a => String(a.props.href).endsWith('&download=')), 'download forces a file')
 await act(async () => view.unmount())
})

const item = (over) => ({ key: 'x', kind: 'SERVICIO', id: null, concept: 'MONTACARGAS', request_number: 'RT-002314', contract_id: null, contract_code: null, origin: 'SOLICITUD', supplier: null,
 referential_pen: 0, agreed_pen: 0, final_pen: null, extras_pen: null, billing_unit: null, executed_qty: null, billable_qty: null, reason: null, validated_at: null, validated_by: null, status: 'POR_VALIDAR', ...over })
const econOf = (items, requests = 1) => ({ success: true, dispatch_number: '10103', route_status: 'EN RUTA', state: { status: 'PENDIENTE', route_status: 'EN RUTA', pending: [], referential_pen: 650, agreed_pen: 650, final_pen: null, extras_pen: 0 },
 items, requests: Array.from({ length: requests }, (_, i) => ({ id: 's' + (i + 1), request_number: i ? 'RT-9' + i : 'RT-002314', contract_code: null, doc_status: null })), can_validate: false, can_approve: false })
const openCosts = async props => { let view; await act(async () => { view = create(React.createElement(DispatchDetailModal, { row: row(), onClose() {}, ...props })) }); await act(flush)
 await act(async () => tab(view, 'Costos').props.onClick()); await act(flush); return view }

test('a consolidated route freight is never attributed to the request; route expenses stay apart', async () => {
 detail = base({ dispatch: { ...base().dispatch, services_count: 2 } }); expenses = { data: [{ id: 'g1', expense_type: 'COMBUSTIBLE', amount: 120, status: 'APROBADO', description: 'Carga en ruta', created_at: null }], error: null }
 econ = econOf([item({ key: 'F:d1', kind: 'FLETE', concept: 'FLETE', request_number: 'RT-002314, RT-91', referential_pen: 650, agreed_pen: 650 }), item({ key: 'S:1', agreed_pen: 48 }), item({ key: 'S:2', request_number: 'RT-91', agreed_pen: 500 })], 2)
 const view = await openCosts({ economicHref: '/despacho/documentos/economico?despacho=d1' })
 assert.ok(text(view).includes('Flete de la ruta completa (2 servicios)'))
 assert.ok(text(view).includes('Costo total de la solicitudS/ 48.00'), 'only the request service counts')
 assert.ok(text(view).includes('Combustible')); assert.ok(text(view).includes('no se atribuyen a una solicitud'))
 assert.ok(view.root.findAllByType('a').some(a => a.props.href === '/despacho/documentos/economico?despacho=d1'))
 await act(async () => view.unmount())
})

test('per-request freight is attributed and no economic access shows nothing', async () => {
 detail = base({ dispatch: { ...base().dispatch, services_count: 2 } }); expenses = { data: null, error: { message: 'rls' } }
 econ = econOf([item({ key: 'F:s1', kind: 'FLETE', concept: 'FLETE', agreed_pen: 300, final_pen: 320 }), item({ key: 'S:1', agreed_pen: 48, final_pen: 50 })], 2)
 let view = await openCosts({})
 assert.ok(text(view).includes('Costo total de la solicitudS/ 370.00')); assert.ok(text(view).includes('Sin acceso a los gastos de Caja de la ruta.'))
 await act(async () => view.unmount())
 econ = { success: false, error: 'Sin acceso al cierre económico' }
 view = await openCosts({})
 assert.ok(text(view).includes('Sin acceso al cierre económico')); assert.ok(!text(view).includes('S/ '))
 await act(async () => view.unmount())
})

test('the map draws only recorded GPS points and never for units without the app', async () => {
 detail = base(); track = { data: Array.from({ length: 900 }, (_, i) => ({ recorded_at: new Date(Date.UTC(2026, 9, 30, 21, 25) + i * 5000).toISOString(), latitude: -12.1 - i / 1e4, longitude: -76.9 + i / 1e4 })), error: null }
 let view; await act(async () => { view = create(React.createElement(DispatchDetailModal, { row: row(), onClose() {} })) }); await act(flush)
 await act(async () => tab(view, 'Ruta y seguimiento').props.onClick()); await act(flush)
 assert.equal(view.root.findByProps({ 'data-map-points': 400 }).props['data-map-points'], 400, 'long tracks are thinned for drawing')
 assert.ok(text(view).includes('Recorrido real del app'))
 await act(async () => view.unmount())
 track = { data: [], error: null }
 await act(async () => { view = create(React.createElement(DispatchDetailModal, { row: row(), onClose() {} })) }); await act(flush)
 await act(async () => tab(view, 'Ruta y seguimiento').props.onClick()); await act(flush)
 assert.ok(text(view).includes('Sin puntos GPS registrados')); assert.equal(view.root.findAllByProps({ 'data-map-points': 0 }).length, 0)
 await act(async () => view.unmount())
 detail = base({ presence: { applies: false, connected: false, last_seen_at: null, gps_state: null, gps_at: null, server_now: '2026-10-30T23:00:00Z' } })
 await act(async () => { view = create(React.createElement(DispatchDetailModal, { row: row({ modalidad: 'TERCERO' }), onClose() {} })) }); await act(flush)
 await act(async () => tab(view, 'Ruta y seguimiento').props.onClick()); await act(flush)
 assert.ok(!text(view).includes('Cargando recorrido') && !text(view).includes('Sin puntos GPS'), 'no track query for third parties')
 await act(async () => view.unmount())
})

test('the OSRM estimate saved when programming shows time and suggested route; nothing is drawn without it', async () => {
 detail = base({ presence: { ...base().presence, applies: false }, estimate: { distance_km: 70.4, duration_min: 110, origin: { lat: -12.09, lon: -76.87 }, destination: { lat: -12.52, lon: -76.73 },
  geometry: [[-12.09, -76.87], [-12.3, -76.8], [-12.52, -76.73]], source: 'OSRM', computed_at: '2026-10-30T15:00:00Z' } })
 let view; await act(async () => { view = create(React.createElement(DispatchDetailModal, { row: row({ modalidad: 'TERCERO' }), onClose() {} })) }); await act(flush)
 await act(async () => tab(view, 'Ruta y seguimiento').props.onClick()); await act(flush)
 assert.ok(text(view).includes('1 h 50 min')); assert.ok(text(view).includes('70.4 km'))
 assert.equal(view.root.findByProps({ 'data-planned': 3 }).props['data-map-points'], 0, 'suggested route without inventing GPS points')
 assert.ok(text(view).includes('Ruta sugerida (OSRM)'))
 await act(async () => view.unmount())
})

test('operational evidence carries its stage, can be added by operators and is voided with a reason, never deleted', async () => {
 calls.length = 0; detail = base(); files = { ...filesBase(), can_add_evidence: true, evidence: [
  { id: 'ev1', stage: 'RECOJO', file_path: 'd1/evidencia/u1/a.jpg', file_name: 'a.jpg', mime_type: 'image/jpeg', size_bytes: 1200000, note: 'Unidad en punto de recojo', uploaded_at: '2026-10-30T21:25:00Z', uploaded_by: 'Juan Pérez', scope: 'SERVICIO', can_void: true }] }
 let prompted = null; global.window.prompt = message => { prompted = message; return 'Foto de otra unidad por error' }
 let view; await act(async () => { view = create(React.createElement(DispatchDetailModal, { row: row(), onClose() {} })) }); await act(flush)
 await act(async () => tab(view, 'Fotos y evidencias').props.onClick()); await act(flush)
 assert.ok(text(view).includes('Recojo (1)')); assert.ok(text(view).includes('Unidad en punto de recojo')); assert.ok(button(view, 'Agregar evidencia'))
 assert.ok(text(view).includes('JPG, PNG o PDF (máx. 10 MB)'), 'configured limit')
 await act(async () => view.root.findAllByProps({ 'aria-label': 'Ver Unidad en punto de recojo' })[0].props.onClick())
 await act(async () => button(view, 'Anular').props.onClick()); await act(flush)
 assert.match(prompted, /Motivo/); assert.deepEqual(calls.find(c => c.name === 'void_dispatch_evidence').args, { p_id: 'ev1', p_reason: 'Foto de otra unidad por error' })
 await act(async () => button(view, 'Agregar evidencia').props.onClick())
 assert.ok(view.root.findAllByProps({ 'aria-label': 'Agregar evidencia' }).some(n => n.props.role === 'dialog'))
 await act(async () => view.unmount())
})

test('history filters by source with real events only', async () => {
 detail = base(); let view
 await act(async () => { view = create(React.createElement(DispatchDetailModal, { row: row(), onClose() {} })) }); await act(flush)
 await act(async () => tab(view, 'Historial').props.onClick())
 assert.equal(view.root.findAllByType('tbody')[0].findAllByType('tr').length, 2)
 const select = view.root.findAllByType('select').find(s => s.props.children[0].props.children === 'Todos los eventos')
 await act(async () => select.props.onChange({ target: { value: 'OPERACION' } }))
 await act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {} }))
 assert.equal(view.root.findAllByType('tbody')[0].findAllByType('tr').length, 1)
 assert.ok(text(view).includes('Retraso'))
 await act(async () => view.unmount())
})

test('milestones never close a step without its record and pendings come from the stop', () => {
 const d = base({ milestones: { ...base().milestones, conformidad: { decision: 'OBSERVADA', reason: 'Foto borrosa', at: '2026-10-30T23:00:00Z', by: 'Ana' } } })
 const steps = lib.milestones(d, { conformity: 'OBSERVADA' }, true)
 assert.deepEqual(steps.map(s => s.state), ['done', 'done', 'done', 'alert', 'pending', 'pending'])
 assert.equal(lib.milestones(base(), { conformity: 'RECIBIDA' })[3].state, 'current')
 assert.deepEqual(lib.pendingItems(row({ conformity: 'PENDIENTE' })).map(p => p.key), ['guia'])
 assert.deepEqual(lib.pendingItems(row({ conformity: 'VALIDADA' })), [])
 assert.equal(lib.gpsStatus(base({ presence: { ...base().presence, connected: true } }), { modalidad: 'PROPIA' }).label, 'En línea')
})

test('tower table uses the new detail while the public portal keeps the simple one', async () => {
 let view, shown = null
 await act(async () => { view = create(React.createElement(DeliveryTable, { rows: [row()], onRefresh() {}, renderDetail: (r, c) => { shown = { r, c }; return React.createElement('p', null, 'detalle nuevo') } })) })
 await act(async () => view.root.findAllByProps({ 'aria-label': 'Ver detalle' })[0].props.onClick())
 assert.equal(shown.r.request_id, 's1'); assert.ok(text(view).includes('detalle nuevo')); assert.ok(!text(view).includes('Bitácora e historial de avance'))
 await act(async () => shown.c.close()); assert.ok(!text(view).includes('detalle nuevo'))
 await act(async () => view.unmount())
 await act(async () => { view = create(React.createElement(DeliveryTable, { rows: [row()], onRefresh() {} })) })
 await act(async () => view.root.findAllByProps({ 'aria-label': 'Ver detalle' })[0].props.onClick())
 assert.ok(text(view).includes('Bitácora e historial de avance'))
 await act(async () => view.unmount())
})

test('download-all zip is a valid stored archive', async () => {
 const { crc32, zipFiles, zipName } = load('src/lib/zip.ts')
 assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926)
 const used = new Set(), names = [zipName('01-Recojo-Unidad en punto', 'jpg', used), zipName('01-Recojo-Unidad en punto', 'jpg', used)]
 assert.deepEqual(names, ['01-Recojo-Unidad-en-punto.jpg', '01-Recojo-Unidad-en-punto-2.jpg'])
 const bytes = new Uint8Array(await zipFiles([{ name: names[0], data: new Uint8Array([1, 2, 3]) }, { name: names[1], data: new Uint8Array([4]) }]).arrayBuffer())
 const view = new DataView(bytes.buffer)
 assert.equal(view.getUint32(0, true), 0x04034b50, 'local header'); assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50, 'end of central directory')
 assert.equal(view.getUint16(bytes.length - 12, true), 2, 'two entries')
})
