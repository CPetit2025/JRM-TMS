const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript'), React = require('react')
const { create, act } = require('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT = true
global.document = { addEventListener() {}, removeEventListener() {} }
const cache = new Map()
function load(file, overrides = {}) {
 const filename = path.resolve(__dirname, '..', file)
 if (cache.has(filename)) return cache.get(filename)
 const m = new Module(filename, module); m.paths = module.paths
 m.require = name => {
  if (name in overrides) return overrides[name]
  if (name === '@/components/ui/data-table') return { DataTable: ({ children }) => React.createElement('table', null, children) }
  if (name === '@/components/ui/modal') return { Modal: () => null }
  if (name === 'sonner') return { toast: { error() {} } }
  if (name.endsWith('.css')) return {}
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
const { routeIds, routeShareText, routeEventChanges } = load('src/lib/route-share.ts')
test('logistics providers have a dedicated master path and permission, separate from commercial providers', () => {
 const { visibleSections } = load('src/lib/nav/navConfig.ts')
 const { canOpenPath } = load('src/lib/nav/web-access.ts')
 const sections = visibleSections(permission => permission === 'proveedores-logisticos')
 const logistics = sections.find(section => section.id === 'maestros')
 assert.equal(logistics.title, 'Proveedores logísticos')
 assert.ok(logistics.groups.flatMap(group => group.items).some(item => item.href === '/maestros/proveedores'))
 assert.equal(canOpenPath('Operador', ['proveedores-logisticos'], '/maestros/transportistas'), true, 'legacy route redirects to the new master')
 assert.equal(canOpenPath('Operador', ['proveedores-logisticos'], '/proveedores'), false, 'commercial provider path remains separate')
})
const row = (dispatch, request) => ({ dispatch_id: dispatch, dispatch_number: dispatch, request_id: request, request_number: request, plate: 'JRM-001', state: 'PROGRAMADO', events: [], last_event_at: '2026-10-20T12:00:00Z', scheduled_departure: '2026-10-20T12:00:00Z', conformity: 'PENDIENTE', ot_code: 'OT1', photos_count: 0, pickup_address: 'Origen', delivery_address: 'Destino', client_name: 'Cliente Uno', driver_name: 'Conductor Uno' })
test('selection groups a route across deliveries and pages, and exposes cancellation only when authorized', async () => {
 const { DeliveryTable } = load('src/components/delivery/DeliveryTable.tsx')
 const rows = Array.from({ length: 27 }, (_, i) => row(i < 2 ? 'R1' : `R${i}`, `S${i}`)), shares = [], canceled = []
 let view; await act(async () => { view = create(React.createElement(DeliveryTable, { rows, onRefresh() {}, onShareRoutes: ids => shares.push(ids), onCancelRoute: id => canceled.push(id), cancelableRoutes: ['R1'] })) })
 const input = label => view.root.findByProps({ 'aria-label': label })
 await act(async () => input('Seleccionar ruta R1 · S0').props.onChange({ target: { checked: true } }))
 assert.equal(input('Seleccionar ruta R1 · S1').props.checked, true)
 const share = () => view.root.findAllByType('button').find(b => typeof b.children[0] === 'string' && b.children[0].startsWith('Compartir '))
 await act(async () => share().props.onClick()); assert.deepEqual(shares.at(-1), ['R1'])
 const cancel = view.root.findAllByType('button').filter(b => b.children[0] === 'Cancelar ruta')
 assert.equal(cancel.length, 2); await act(async () => cancel[0].props.onClick()); assert.deepEqual(canceled, ['R1'])
 await act(async () => input('Seleccionar todas las rutas filtradas').props.onChange({ target: { checked: true } }))
 await act(async () => share().props.onClick()); assert.equal(shares.at(-1).length, 26); assert.deepEqual(shares.at(-1), routeIds(rows))
 await act(async () => input('Seleccionar todas las rutas filtradas').props.onChange({ target: { checked: false } }))
 assert.equal(share().props.disabled, true)
 await act(async () => view.unmount())
 await act(async () => { view = create(React.createElement(DeliveryTable, { rows, onRefresh() {} })) })
 assert.equal(view.root.findAllByProps({ 'aria-label': 'Seleccionar todas las rutas filtradas' }).length, 0)
 assert.equal(view.root.findAllByType('button').filter(b => b.children[0] === 'Cancelar ruta').length, 0)
 await act(async () => view.unmount())
})
test('sharing contains license, auxiliaries, forklift and every service without credentials or costs', () => {
 const text = routeShareText([{ id: 'r', number: 'R1', plate: 'JRM-001', status: 'PROGRAMADO', departure: '2026-10-20T12:00:00Z', driver: 'Conductor Uno', driver_license: 'LIC-001', auxiliaries: [{ code: 'T001', name: 'Auxiliar Uno', document_number: '12345678' }], forklift: { supplier: 'Montacargas Uno', tax_id: '20111111111', operator_name: 'Operador Uno', license_number: 'ACR-001' }, services: [row('R1', 'S1'), row('R1', 'S2')], pin: 'NO-COMPARTIR', freight_cost: 'NO-COSTOS' }])
 for (const expected of ['LIC-001', 'Auxiliar Uno', '12345678', 'ACR-001', 'Montacargas Uno', 'Cliente Uno', 'S1', 'S2']) assert.ok(text.includes(expected), expected)
 assert.ok(!text.includes('NO-COMPARTIR')); assert.ok(!text.includes('NO-COSTOS'))
})
test('public alerts ignore initial load, unrelated rows, backfilled history and unchanged refreshes', () => {
 const initial = row('R1', 'S1'), first = routeEventChanges(new Map(), [initial])
 assert.equal(first.changes.length, 0)
 assert.equal(routeEventChanges(first.snapshot, [initial, row('R2', 'S2')]).changes.length, 0)
 const changed = { ...initial, events: [{ at: '2026-10-20T13:00:00Z', type: 'EN_RUTA', description: 'Salida' }], last_event_at: '2026-10-20T13:00:00Z', state: 'EN_CURSO' }
 const next = routeEventChanges(first.snapshot, [changed]); assert.equal(next.changes.length, 1)
 assert.equal(routeEventChanges(next.snapshot, [changed]).changes.length, 0)
 assert.equal(routeEventChanges(next.snapshot, [{ ...changed, events: [...changed.events, { at: '2026-10-19T13:00:00Z', type: 'ANTIGUO' }] }]).changes.length, 0)
 assert.equal(routeEventChanges(new Map(), [changed]).changes.length, 0, 'new access/range starts a clean baseline')
})
test('forklift selects recorded operator credentials and creates its supplier without leaving the form', async () => {
 const calls = [], person = { id: 'p1', code: 'T001', name: 'Operador Uno', document_number: '12345678', license_number: 'ACR-001', license_expiration: '2099-01-01', phone: '999111222' }
 const supplierPerson = { id: 'sp1', supplier_id: 'supplier-new', full_name: 'Operador Proveedor', document_number: '87654321', position: 'Montacarguista', license_number: 'MONT-001', license_expiration: '2099-02-01', phone: '999222333' }
 const client = { from: table => ({ select: () => {
  const filters = [], query = { eq: (key, value) => { filters.push([key, value]); return query }, in: () => query,
   order: async () => ({ data: table === 'supplier_personnel' && filters.some(([key, value]) => key === 'supplier_id' && value === 'supplier-new') ? [supplierPerson] : [] }) }
  return query
 } }), rpc: async (name, args) => { calls.push({ name, args }); return { data: 'supplier-new' } } }
 const { ForkliftFields, EMPTY_FORKLIFT, forkliftValid } = load('src/components/despacho/ForkliftFields.tsx', { '@/lib/supabase/client': { createClient: () => client }, sonner: { toast: { success() {}, error() {} } } })
 let value
 function Form() { const [f, setF] = React.useState(EMPTY_FORKLIFT); value = f; return React.createElement(ForkliftFields, { value: f, onChange: setF }) }
 let view; await act(async () => { view = create(React.createElement(Form)) })
 await act(async () => view.root.findByType('input').props.onChange({ target: { checked: true } }))
 assert.equal(forkliftValid(value), false)
 const button = label => view.root.findAllByType('button').find(b => b.children[0] === label)
 await act(async () => button('+ Nuevo proveedor').props.onClick())
 await act(async () => view.root.findByProps({ 'aria-label': 'Nuevo proveedor · RUC' }).props.onChange({ target: { value: '20100070970' } }))
 await act(async () => view.root.findByProps({ 'aria-label': 'Nuevo proveedor · Razón social' }).props.onChange({ target: { value: 'Proveedor Uno' } }))
 await act(async () => button('Registrar proveedor').props.onClick())
 await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
 assert.equal(value.supplier_id, 'supplier-new')
 assert.equal(calls.at(-1).name, 'save_supplier')
 assert.equal(calls.at(-1).args.p_supplier.category, 'MONTACARGA')
 const picker = view.root.findAll(node => node.props.ariaLabel === 'Montacarguista registrado' && typeof node.type === 'function')[0]
 assert.ok(picker.props.options.some(option => option.value === supplierPerson.id && option.label.includes(supplierPerson.full_name)))
 assert.ok(picker.props.options.every(option => option.value !== person.id && !option.label.includes('Personal interno')), 'registered selector only lists the selected supplier personnel')
 assert.equal(calls.some(call => call.name === 'route_forklift_candidates'), false, 'internal personnel candidates are not loaded for this selector')
 await act(async () => picker.props.onChange('sp1'))
 assert.equal(value.operator_name, supplierPerson.full_name); assert.equal(value.license_number, supplierPerson.license_number); assert.equal(value.document_number, supplierPerson.document_number)
 await act(async () => view.root.findByProps({ 'aria-label': 'Tarifa montacarga por hora' }).props.onChange({ target: { value: '75.50' } }))
 assert.equal(forkliftValid(value), true)
 await act(async () => view.unmount())
})
