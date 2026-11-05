// Hallazgos de auditoría (F2, interfaz): se renderiza /despacho/hallazgos y el formulario con RPC simulados (sin red ni base)
// y se prueban filtros, indicadores, botones según permiso y el bloqueo del cierre Conforme sin foto DESPUÉS.
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript'), React = require('react')
const { create, act } = require('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT = true

const rpcCalls = []
let perms = { role: 'auditor de despacho', permissions: ['hallazgos:write', 'hallazgos-validar'] }
let detail = null
const row = (n, extra = {}) => ({ id: `f${n}`, number: `HAL-2026-0000${n}`, registered_at: '2026-11-05T14:00:00Z', ot_code: `24${n}`, client_name: n === 1 ? 'Cliente Norte' : 'Cliente Sur', contract_id: `c${n}`, client_id: `cl${n}`,
  categories: ['Material faltante', 'Rotulado'], severity: 'MAYOR', status: 'ABIERTO', responsible_id: null, responsible_name: null, auditor_id: 'u-aud', auditor_name: 'Ana', due_date: null, overdue: false, ...extra })
const ROWS = [row(1), row(2, { status: 'PENDIENTE_VALIDACION', responsible_id: 'u-resp', responsible_name: 'Juan', due_date: '2026-11-01', overdue: true }), row(3, { status: 'CERRADO', severity: 'MENOR', client_name: 'Cliente Centro' })]
const chain = (result) => new Proxy(function () {}, {
  get(_, key) { if (key === 'then') return (ok, ko) => Promise.resolve(result).then(ok, ko); return () => chain(result) },
  apply() { return chain(result) },
})
const supabase = {
  auth: { getUser: async () => ({ data: { user: { id: 'u-val' } } }) },
  from: () => chain({ data: [{ id: 'cat1', name: 'Material faltante' }, { id: 'cat2', name: 'Estiba o seguridad', is_safety: true }], error: null }),
  storage: { from: () => ({ createSignedUrls: async paths => ({ data: paths.map(p => ({ path: p, signedUrl: `https://signed/${p}` })) }) }) },
  rpc: (name, args) => {
    rpcCalls.push([name, args])
    const data = name === 'audit_finding_list' ? { success: true, rows: ROWS, kpis: { abiertos: 7, vencidos: 2, pendientes_validacion: 3, cerrados: 41 } }
      : name === 'audit_finding_assignable_users' ? [{ id: 'u-resp', full_name: 'Juan' }]
      : name === 'audit_finding_detail' ? { success: true, ...detail } : { success: true }
    return Promise.resolve({ data, error: null })
  },
}
const h = React.createElement
const mocks = {
  '@/lib/supabase/client': { createClient: () => supabase },
  '@/hooks/usePermissions': { usePermissions: () => ({ role: perms.role, permissions: perms.permissions, isLoaded: true,
    canRead: m => perms.role === 'admin' || perms.permissions.some(p => p === m || p.startsWith(`${m}:`)),
    canWrite: m => perms.role === 'admin' || perms.permissions.some(p => p === m || p === `${m}:write`),
    hasAccess: m => perms.role === 'admin' || perms.permissions.some(p => p === m || p.startsWith(`${m}:`)) }) },
  'next/navigation': { useRouter: () => ({ replace() {}, push() {} }), useSearchParams: () => new URLSearchParams('') },
  sonner: { toast: { error() {}, success() {}, info() {} } },
  '@/components/ui/modal': { Modal: ({ isOpen, title, children, footer }) => (isOpen ? h('div', { 'data-modal': title }, children, footer) : null) },
  '@/components/ui/page-header': { PageHeader: ({ title, actions }) => h('header', null, title, actions) },
  '@/components/ui/data-table': { DataTable: ({ children }) => h('table', null, children) },
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
const { FindingsView } = load('src/components/hallazgos/FindingsView.tsx')
const { FindingForm } = load('src/components/hallazgos/FindingForm.tsx')

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)) })
const text = node => typeof node === 'string' ? node : (node.children || []).map(text).join('')
const buttons = (view, label) => view.root.findAllByType('button').filter(b => text(b).trim() === label)
const kpi = (view, label) => text(view.root.find(n => n.props && n.props['data-kpi'] === label))
const lastList = () => rpcCalls.filter(([n]) => n === 'audit_finding_list').at(-1)[1].p_filters

test('indicadores del servidor y filtros: estado/criticidad viajan al RPC; OT y cliente filtran y recalculan', async () => {
  rpcCalls.length = 0; perms = { role: 'auditor de despacho', permissions: ['hallazgos:write', 'hallazgos-validar'] }
  let view
  await act(async () => { view = create(h(FindingsView)) }); await flush()
  assert.deepEqual(['Abiertos', 'Vencidos', 'Pendientes de validación', 'Cerrados'].map(l => kpi(view, l)), ['7', '2', '3', '41'])
  assert.ok(lastList().from && lastList().to, 'período por defecto')
  await act(async () => view.root.findByProps({ 'aria-label': 'Estado' }).props.onChange({ target: { value: 'ABIERTO' } })); await flush()
  await act(async () => view.root.findByProps({ 'aria-label': 'Criticidad' }).props.onChange({ target: { value: 'CRITICO' } })); await flush()
  await act(async () => view.root.findByProps({ 'aria-label': 'Responsable' }).props.onChange({ target: { value: 'u-resp' } })); await flush()
  assert.equal(lastList().status, 'ABIERTO'); assert.equal(lastList().severity, 'CRITICO'); assert.equal(lastList().responsible_id, 'u-resp')
  await act(async () => view.root.findByProps({ 'aria-label': 'Cliente' }).props.onChange({ target: { value: 'sur' } }))
  assert.equal(view.root.findAllByType('tr').length - 1, 1, 'solo la fila del cliente Sur')
  assert.deepEqual(['Abiertos', 'Vencidos', 'Pendientes de validación', 'Cerrados'].map(l => kpi(view, l)), ['1', '1', '1', '0'])
  await act(async () => view.root.findByProps({ 'aria-label': 'Cliente' }).props.onChange({ target: { value: '' } }))
  await act(async () => view.root.findByProps({ 'aria-label': 'OT' }).props.onChange({ target: { value: '243' } }))
  assert.equal(view.root.findAllByType('tr').length - 1, 1)
  await act(async () => view.unmount())
})

test('botones según permiso: escritura edita lo Abierto, validar solo lo pendiente; lectura solo ve', async () => {
  perms = { role: 'auditor de despacho', permissions: ['hallazgos:write', 'hallazgos-validar'] }
  let view
  await act(async () => { view = create(h(FindingsView)) }); await flush()
  assert.equal(buttons(view, 'Registrar hallazgo').length, 1)
  assert.equal(buttons(view, 'Ver').length, 3)
  assert.equal(buttons(view, 'Editar').length, 1, 'solo el ABIERTO')
  assert.equal(buttons(view, 'Validar').length, 1, 'solo el PENDIENTE_VALIDACION')
  await act(async () => view.unmount())
  perms = { role: 'asistente documentario', permissions: ['hallazgos:read'] }
  await act(async () => { view = create(h(FindingsView)) }); await flush()
  assert.equal(buttons(view, 'Registrar hallazgo').length, 0)
  assert.equal(buttons(view, 'Editar').length + buttons(view, 'Validar').length, 0)
  assert.equal(buttons(view, 'Ver').length, 3)
  await act(async () => view.unmount())
})

const pendingDetail = (evidence = []) => ({
  finding: { ...row(2, { status: 'PENDIENTE_VALIDACION', responsible_id: 'u-resp' }), dispatch_id: 'd1', transport_request_id: 'r1', site_id: 's1', destination: 'Trujillo', process_area: 'Despacho', description: 'Faltan 2 cajas',
    material_code: null, material_description: null, quantity: null, unit: null, location: null, observations: null, required_action: 'Completar', responsible_area: 'Almacén', attended_at: '2026-11-05T15:00:00Z', closed_at: null },
  categories: [{ id: 'cat1', name: 'Material faltante' }], evidence,
  corrections: [{ id: 'k1', round: 1, action_executed: 'Se completó', executed_at: '2026-11-05T15:00:00Z', corrected_by: 'u-resp', observations: null, submitted_by: 'u-resp', submitted_at: '2026-11-05T15:00:00Z', validated_by: null, validated_at: null, result: null, validation_comment: null, no_photo_reason: null }],
  events: [{ id: 1, event_type: 'CORRECCION', from_status: 'EN_CORRECCION', to_status: 'PENDIENTE_VALIDACION', actor: 'u-resp', at: '2026-11-05T15:00:00Z', detail: null }],
})
const validateButton = view => buttons(view, 'Registrar validación')[0]

test('Conforme se bloquea sin foto DESPUÉS de la ronda; con foto o motivo se habilita y envía', async () => {
  const can = { write: true, validate: true, admin: false, userId: 'u-val' }
  detail = pendingDetail([{ id: 'e1', finding_id: 'f2', correction_id: null, phase: 'ANTES', file_path: 'f2/ANTES/u/a.jpg', description: null, mime_type: 'image/jpeg', uploaded_by: 'u-aud', uploaded_at: '2026-11-05T14:00:00Z', voided_at: null },
    { id: 'e2', finding_id: 'f2', correction_id: 'k1', phase: 'DESPUES', file_path: 'f2/DESPUES/u/b.jpg', description: null, mime_type: 'image/jpeg', uploaded_by: 'u-resp', uploaded_at: '2026-11-05T15:00:00Z', voided_at: '2026-11-05T15:10:00Z' }])
  let view
  await act(async () => { view = create(h(FindingForm, { findingId: 'f2', initialTab: 'correccion', can, onClose() {} })) }); await flush()
  assert.equal(validateButton(view).props.disabled, true, 'la foto anulada no cuenta')
  assert.ok(view.root.findAll(n => n.props && n.props.role === 'alert').length)
  // «No requiere foto» con motivo habilita el cierre
  await act(async () => view.root.findAllByType('input').find(i => i.props.type === 'checkbox').props.onChange({ target: { checked: true } }))
  assert.equal(validateButton(view).props.disabled, true, 'sin motivo sigue bloqueado')
  await act(async () => view.root.findByProps({ 'aria-label': 'Motivo sin foto' }).props.onChange({ target: { value: 'Faltante repuesto en guía' } }))
  assert.equal(validateButton(view).props.disabled, false)
  rpcCalls.length = 0
  await act(async () => validateButton(view).props.onClick()); await flush()
  const call = rpcCalls.find(([n]) => n === 'audit_finding_validate')
  assert.deepEqual(call[1], { p_id: 'f2', p_result: 'CONFORME', p_comment: null, p_no_photo_reason: 'Faltante repuesto en guía' })
  await act(async () => view.unmount())
  // Con una foto DESPUÉS vigente se puede cerrar sin motivo
  detail = pendingDetail([{ id: 'e3', finding_id: 'f2', correction_id: 'k1', phase: 'DESPUES', file_path: 'f2/DESPUES/u/c.jpg', description: 'Completo', mime_type: 'image/jpeg', uploaded_by: 'u-resp', uploaded_at: '2026-11-05T15:00:00Z', voided_at: null }])
  await act(async () => { view = create(h(FindingForm, { findingId: 'f2', initialTab: 'correccion', can, onClose() {} })) }); await flush()
  assert.equal(validateButton(view).props.disabled, false)
  // Rechazado exige comentario
  await act(async () => buttons(view, 'Rechazado')[0].props.onClick())
  assert.equal(validateButton(view).props.disabled, true)
  await act(async () => view.unmount())
})

test('quien corrigió no valida su propia corrección; el responsable ve el envío de corrección y sube fotos DESPUÉS', async () => {
  detail = pendingDetail()
  let view
  await act(async () => { view = create(h(FindingForm, { findingId: 'f2', initialTab: 'correccion', can: { write: true, validate: true, admin: false, userId: 'u-resp' }, onClose() {} })) }); await flush()
  assert.equal(buttons(view, 'Registrar validación').length, 0)
  await act(async () => view.unmount())
  detail = pendingDetail(); detail.finding.status = 'EN_CORRECCION'
  await act(async () => { view = create(h(FindingForm, { findingId: 'f2', initialTab: 'evidencias', can: { write: false, validate: false, admin: false, userId: 'u-resp' }, onClose() {} })) }); await flush()
  const cameras = view.root.findAllByType('input').filter(i => i.props.type === 'file')
  assert.equal(cameras.length, 2, 'solo la columna DESPUÉS permite subir')
  assert.ok(cameras.some(i => i.props.capture === 'environment'))
  assert.ok(cameras.every(i => i.props.accept === 'image/jpeg,image/png,image/webp'))
  await act(async () => view.unmount())
})
