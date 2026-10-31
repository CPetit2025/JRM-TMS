// Armado de ruta por etapas (src/components/despacho/programar-ruta): se renderiza el modal completo con datos simulados
// (sin red ni base) y se recorre: selección, bloqueo al avanzar sin unidad ni flete, flete pactado obligatorio con
// tercero, orden de paradas, adicionales, salida con observaciones obligatorias y el payload de programación.
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript'), React = require('react')
const { create, act } = require('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT = true
global.document = { addEventListener() {}, removeEventListener() {}, getElementById() { return null } }
global.window = { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {}, confirm: () => true, location: { origin: 'http://localhost' } }

const rpcCalls = []
const chain = (result) => new Proxy(function () {}, {
 get(_, key) { if (key === 'then') return (ok, ko) => Promise.resolve(result).then(ok, ko); return () => chain(result) },
 apply() { return chain(result) },
})
const supabase = {
 from: table => chain({ data: table === 'transport_unloading_costs' ? [] : [], error: null }),
 rpc: (name, args) => { rpcCalls.push([name, args]); return Promise.resolve(name === 'schedule_route_resources' ? { data: 'route-1', error: null } : name === 'erp_stock_corte' ? { data: { success: true, estado: 'DESACTUALIZADO', horas: 60, max_horas: 48 }, error: null } : { data: null, error: null }) },
}
const h = React.createElement
const mocks = {
 '@/lib/supabase/client': { createClient: () => supabase },
 sonner: { toast: { error() {}, success() {}, loading() { return 1 } } },
 'next/link': { __esModule: true, default: ({ children }) => h('a', null, children) },
 '@/components/ui/modal': { Modal: ({ isOpen, children, footer }) => (isOpen ? h('div', null, children, footer) : null) },
 '@/components/ui/SearchableSelect': { SearchableSelect: ({ value, onChange, options, ariaLabel }) => h('select', { 'aria-label': ariaLabel, value, onChange: e => onChange(e.target.value) }, options.map(o => h('option', { key: o.value, value: o.value }, o.label))) },
 '@/components/tarifas/TransportTariffManager': { QuoteBreakdown: () => null },
 '@/components/erp/ErpReferencia': { ErpOtLinea: () => null, ErpStockCorteAviso: () => null },
 '@/lib/routing': { calculateRouteDistance: async () => 12.5 },
 '@/lib/eligibility': { checkDispatchEligibility: async () => ({ status: 'APTO', blocking_reasons: [], observation_reasons: [] }) },
 '@/components/despacho/Tercero': { TERCERO_VACIO: { carrier_id: '', supplier_vehicle_id: '', supplier_personnel_id: '', placa: '', conductor: '', telefono: '', doc: '', license_number: '', license_expiration: '' },
  TerceroFields: ({ value, onChange }) => h('button', { type: 'button', 'aria-label': 'Completar tercero', onClick: () => onChange({ ...value, carrier_id: 'c1', placa: 'ABC-123', conductor: 'Chofer', telefono: '999', doc: '12345678' }) }) },
}
const cache = new Map()
function load(file) {
 const filename = path.resolve(__dirname, '..', file)
 if (cache.has(filename)) return cache.get(filename)
 const m = new Module(filename, module); m.paths = module.paths
 m.require = name => {
  if (name in mocks) return mocks[name]
  if (name.startsWith('@/') || name.startsWith('.')) {
   const base = name.startsWith('@/') ? path.resolve(__dirname, '../src', name.slice(2)) : path.resolve(path.dirname(filename), name)
   const found = ['.ts', '.tsx', '/index.ts', '/index.tsx'].map(ext => base + ext).find(fs.existsSync)
   if (found) return load(path.relative(path.resolve(__dirname, '..'), found))
  }
  return require(name)
 }
 m._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename)
 cache.set(filename, m.exports); return m.exports
}
const { useRouteBuilder } = load('src/components/despacho/programar-ruta/useRouteBuilder.ts')
const { RouteBuilderModal } = load('src/components/despacho/programar-ruta/RouteBuilderModal.tsx')

const request = (n, extra = {}) => ({ id: `r${n}`, request_number: `RT-00${n}`, requester_name: 'Ana', pickup_address: 'Av. Planta 1, Chilca', delivery_address: `Calle ${n}, Trujillo`,
 attention_mode: 'TRANSPORTE_JRM', site_id: 's1', request_type: 'DESPACHO', status: 'APROBADA', created_at: '2026-10-30T10:00:00Z', required_date: '2026-10-31',
 contract_id: 'ot1', contracts: { id: 'ot1', code: '16566', clients: { business_name: 'Operadora' } }, client_id: 'cl1', estimated_weight: 1000, service_cost: 300, ...extra })
let rb
function Harness({ requests, vehicles }) {
 const [pending, setPending] = React.useState(requests)
 rb = useRouteBuilder({ supabase, pendingRequests: pending, setPendingRequests: setPending, dispatches: [], vehicles, drivers: [{ id: 'd1', first_name: 'Carlos', last_name: 'Mendoza', document_number: '1', profile_id: 'p1', carriers: null }],
  fetchData() {}, canAddService: false, router: { push() {} }, onLinkRequest() {} })
 React.useEffect(() => { rb.setIsModalOpen(true) }, [])
 return h(RouteBuilderModal, { rb, onLink() {} })
}
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const byLabel = (view, label) => view.root.findByProps({ 'aria-label': label })
const buttons = (view, text) => view.root.findAllByType('button').filter(b => b.findAll(n => typeof n === 'string' && n.includes(text), { deep: true }).length || [].concat(b.props.children).some(c => typeof c === 'string' && c.includes(text)))
const submit = view => act(async () => view.root.findByProps({ id: 'route-form' }).props.onSubmit({ preventDefault() {} }))

test('five steps: blocked advance, mandatory freight, stop order, late departure needs notes, payload unchanged', async () => {
 rpcCalls.length = 0
 const vehicles = [{ plate: 'B7X-932', status: 'DISPONIBLE', type: 'CAMION', brand: 'Volvo', model: 'FH', assigned_driver_id: 'd1', weight_capacity: 2100, volume_capacity: 28, carriers: null }]
 let view
 await act(async () => { view = create(h(Harness, { requests: [request(1), request(2, { required_date: '2026-10-31', time_window: '08:00 - 12:00' })], vehicles })) })
 await flush()
 assert.equal(rb.step, 1)
 // Sin servicios no se avanza
 await submit(view); assert.equal(rb.step, 1)
 await act(async () => byLabel(view, 'Seleccionar RT-001').props.onChange()); await flush()
 await act(async () => byLabel(view, 'Seleccionar RT-002').props.onChange()); await flush()
 assert.deepEqual(rb.newDispatch.selected_requests.map(r => r.id), ['r1', 'r2'])
 assert.equal(rb.newDispatch.estimated_distance_km, 25)
 assert.ok(rb.checks.some(c => c.key === 'stock' && c.level === 'warn'), 'stale ERP stock is a warning')
 // Orden de paradas
 await act(async () => rb.moveStop('r2', 0))
 assert.deepEqual(rb.newDispatch.selected_requests.map(r => r.id), ['r2', 'r1'])
 await submit(view); assert.equal(rb.step, 2)
 // Sin placa ni flete no se pasa de Transporte
 await submit(view); assert.equal(rb.step, 2)
 assert.ok(rb.checks.some(c => c.key === 'placa'))
 assert.ok(rb.checks.some(c => c.key === 'flete-propio'), 'own-fleet freight must be typed (no silent tariff)')
 await act(async () => byLabel(view, 'Placa del vehículo').props.onChange({ target: { value: 'B7X-932' } })); await flush()
 assert.equal(rb.newDispatch.driver_name, 'Carlos Mendoza', 'assigned driver is proposed')
 await act(async () => byLabel(view, 'Flete de la ruta').props.onChange({ target: { value: '650' } }))
 assert.ok(!rb.checks.some(c => c.key.startsWith('flete-')))
 assert.ok(rb.checks.some(c => c.key === 'motivo-flete'), 'differs from referential (600) → reason')
 await act(async () => rb.setFreightReason('Peaje nuevo en la ruta'))
 assert.ok(!rb.checks.some(c => c.key === 'capacidad'), '2000 kg fit in 2100 kg')
 assert.ok(rb.checks.some(c => c.key === 'capacidad-90'), 'over 90 % warns')
 // Tercero: el flete pactado se escribe
 await act(async () => rb.changeModalidad('TERCERO')); await act(async () => rb.setManualFreightCost(''))
 assert.ok(rb.checks.some(c => c.key === 'flete-tercero' && c.level === 'block'))
 await act(async () => byLabel(view, 'Completar tercero').props.onClick())
 await act(async () => byLabel(view, 'Flete pactado con el proveedor').props.onChange({ target: { value: '650' } }))
 assert.ok(!rb.checks.some(c => c.step === 2 && c.level === 'block'), JSON.stringify(rb.checks))
 await submit(view); assert.equal(rb.step, 3)
 await submit(view); assert.equal(rb.step, 4)
 // Salida después de la ventana de RT-002: observaciones obligatorias
 await act(async () => byLabel(view, 'Fecha Programada Salida').props.onChange({ target: { value: '2026-10-31T13:00' } }))
 assert.deepEqual(rb.late.map(r => r.request_number), ['RT-001', 'RT-002'].filter(n => n === 'RT-002'))
 await submit(view); assert.equal(rb.step, 4)
 await act(async () => rb.setNotes('El cliente recibe por la tarde'))
 await submit(view); assert.equal(rb.step, 5)
 assert.equal(rb.blockers.length, 0)
 await submit(view); await flush()
 const call = rpcCalls.find(([name]) => name === 'schedule_route_resources')
 assert.ok(call, 'programs the route')
 assert.equal(call[1].p.mode, 'TERCERO')
 assert.equal(call[1].p.p_freight_cost, 650)
 assert.equal(call[1].p.freight_reason, 'Peaje nuevo en la ruta')
 assert.deepEqual(call[1].p.p_requests.map(r => r.id), ['r2', 'r1'], 'stop order is sent')
 assert.ok(rpcCalls.some(([name, args]) => name === 'set_dispatch_programming_notes' && args.p_notes === 'El cliente recibe por la tarde'))
 assert.equal(rb.step, 1, 'form resets after programming')
 await act(async () => view.unmount())
})

test('declared weight over the unit capacity blocks; customer pickup needs no unit or freight', async () => {
 const vehicles = [{ plate: 'SMALL', status: 'DISPONIBLE', type: 'CAMION', brand: '', model: '', assigned_driver_id: 'd1', weight_capacity: 1500, volume_capacity: null, carriers: null }]
 let view
 await act(async () => { view = create(h(Harness, { requests: [request(1), request(2), request(3, { attention_mode: 'RECOJO_CLIENTE', site_id: 's1' })], vehicles })) })
 await flush()
 await act(async () => byLabel(view, 'Seleccionar RT-001').props.onChange()); await flush()
 await act(async () => byLabel(view, 'Seleccionar RT-002').props.onChange()); await flush()
 await act(async () => rb.changeVehicle('SMALL')); await flush()
 assert.ok(rb.checks.some(c => c.key === 'capacidad' && c.level === 'block'))
 await act(async () => view.unmount())
 await act(async () => { view = create(h(Harness, { requests: [request(3, { attention_mode: 'RECOJO_CLIENTE' })], vehicles })) })
 await flush()
 await act(async () => byLabel(view, 'Seleccionar RT-003').props.onChange()); await flush()
 assert.equal(rb.newDispatch.document_type, 'NOTA_SALIDA')
 assert.deepEqual(rb.blockers.map(c => c.key), [])
 await act(async () => view.unmount())
})
