const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const Module = require('node:module')
function load(relative, mocks = {}) {
  const file = path.resolve(__dirname, '..', relative)
  const mod = new Module(file, module)
  mod.paths = module.paths
  const native = mod.require.bind(mod)
  mod.require = name => name in mocks ? mocks[name] : name.startsWith('.') ? load(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(file), `${name}.ts`)), mocks) : native(name)
  mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText, file)
  return mod.exports
}
const model = load('src/lib/analytics/model.ts')
const kpi = load('src/lib/analytics/kpi.ts')
const api = load('src/lib/analytics/api.ts', { '@/lib/supabase/client': {}, '@/lib/apt/api': {}, '@/lib/fleet/api': {} })
const filters = model.defaults(new Date('2026-10-04T12:00:00Z'))
const row = (id, values = {}) => ({ id, code: id, date: '2026-10-01', status: 'ENTREGADO', client: '', contract: '', plate: '', driver: '', route: '', site: '', values, detail: {} })

test('fechas usan Lima; rangos inválidos y datos guardados corruptos se rechazan', () => {
  assert.equal(model.limaToday(new Date('2026-10-04T02:00:00Z')), '2026-10-03')
  assert.equal(model.validDate('2026-02-30'), false)
  assert.equal(model.previousMonth(new Date('2026-01-01T02:00:00Z')), '2025-11-01')
  assert.ok(model.validateRange({ from: '2026-10-05', to: '2026-10-04' }))
  assert.equal(model.parseFilters('{bad').compare, 'previous')
  assert.equal(model.parseFilters('{"compare":"unexpected"}').compare, 'previous')
})
test('comparación usa igual duración y ajusta años bisiestos', () => {
  assert.deepEqual(model.comparisonRange({ from: '2026-10-01', to: '2026-10-04', compare: 'previous' }), { from: '2026-09-27', to: '2026-09-30' })
  assert.deepEqual(model.comparisonRange({ from: '2024-02-29', to: '2024-03-01', compare: 'year' }), { from: '2023-02-28', to: '2023-03-01' })
  assert.equal(model.comparisonRange({ ...filters, compare: 'none' }), null)
})
test('presets calculan semana de lunes y trimestre', () => {
  const now = new Date('2026-10-04T12:00:00Z')
  assert.deepEqual(model.presetRange('week', now), { from: '2026-09-28', to: '2026-10-04' })
  assert.deepEqual(model.presetRange('quarter', now), { from: '2026-10-01', to: '2026-10-04' })
})
test('cambiar perspectiva elimina dimensiones incompatibles', () => {
  assert.equal(model.forPerspective({ ...filters, client: 'A', plate: 'B', driver: 'C' }, 'mantenimiento').client, '')
  assert.equal(model.forPerspective({ ...filters, client: 'A', plate: 'B' }, 'mantenimiento').plate, 'B')
  assert.equal(model.forPerspective({ ...filters, client: 'A', plate: 'B' }, 'resumen').plate, '')
})
test('un despacho con varias solicitudes no duplica viajes ni incidencias', () => {
  const request = client => ({ transport_requests: { pickup_address: 'Lima', delivery_address: 'Callao', contracts: { code: 'OT1', clients: { business_name: client } } } })
  const r = api.transportRow({ id: '1', dispatch_number: 'D1', status: 'ENTREGADO', scheduled_departure: '2026-10-02T01:00:00Z', dispatch_requests: [request('A'), request('B')], dispatch_events: [{ event_type: 'INCIDENCIA' }, { event_type: 'RETRASO' }] })
  assert.equal(r.date, '2026-10-01')
  assert.equal(r.values.incident, 1)
  assert.equal(model.aggregate('transporte', [r])[0].value, 1)
  assert.equal(model.filterRows([r], { ...filters, client: 'B' }).length, 1)
  assert.equal(model.filterRows([r], { ...filters, client: 'X' }).length, 0)
})
test('costo/km excluye gastos de viajes sin km y no confunde cero con sin dato', () => {
  const rows = [row('a', { income: 200, expenses: 100, km: 10 }), row('b', { income: 0, expenses: 900, km: null })]
  const metrics = model.aggregate('costos', rows)
  assert.equal(metrics.find(m => m.key === 'cost_km').value, 10)
  assert.equal(metrics.find(m => m.key === 'margin').value, -800)
  assert.equal(model.aggregate('costos', [row('x', { income: 0, expenses: 0 })]).find(m => m.key === 'margin_pct').value, null)
  assert.notEqual(model.formatValue(0), model.formatValue(null))
})
test('paginación lee más de una página y nunca devuelve una carga parcial tras error', async () => {
  const calls = []
  const rows = await model.allPages(async (offset, size) => { calls.push([offset, size]); return { data: offset === 0 ? [1, 2] : [3], error: null } }, 2)
  assert.deepEqual(rows, [1, 2, 3]); assert.deepEqual(calls, [[0, 2], [2, 2]])
  await assert.rejects(model.allPages(async offset => offset ? { data: null, error: { message: 'sin acceso' } } : { data: [1, 2], error: null }, 2), /sin acceso/)
})
test('un límite inferior al solicitado no se presenta como un total completo', async () => {
  await assert.rejects(model.allPages(async () => ({ data: [1, 2], error: null, count: 3 }), 500), /totales parciales/)
})
test('agrupación semanal conserva el total al cruzar un mes', () => {
  const rows = [{ ...row('1'), date: '2026-09-30' }, { ...row('2'), date: '2026-10-01' }]
  assert.deepEqual(model.groups(rows, 'date', 'week'), [{ label: '2026-09-28', count: 2 }])
})
test('filtros KPI recalculan promedios, historia, alertas e informes de la misma cohorte', () => {
  const member = (id, name, indice) => ({ rol: 'DESPACHO', sujeto: id, user_id: id, nombre: name, indice, calificacion: indice < 60 ? 'BAJO' : 'EXCELENTE' })
  const source = { periodo: '2026-10-01', roles: [{ rol: 'DESPACHO', miembros: [member('a', 'Ana', 100), member('b', 'Ana', 40)], tendencia: [{ periodo: '2026-09-01', indice: 75 }, { periodo: '2026-10-01', indice: 70 }] }], informes: [{ rol: 'DESPACHO', user_id: 'a', estado: 'ENVIADO' }, { rol: 'DESPACHO', user_id: 'b', estado: 'OBSERVADO' }], alertas: [] }
  const scoped = kpi.filterKpi(source, { role: '', person: 'b', rating: '', report: '' }, [{ rol: 'DESPACHO', sujeto: 'a', periodo: '2026-09-01', indice: 100 }, { rol: 'DESPACHO', sujeto: 'b', periodo: '2026-09-01', indice: 50 }])
  assert.equal(scoped.general.indice, 40)
  assert.equal(scoped.general.miembros, 1)
  assert.equal(scoped.roles[0].tendencia[0].indice, 50)
  assert.deepEqual(scoped.informes.map(i => i.user_id), ['b'])
})

const React = require('react')
const renderer = require('react-test-renderer')
// Node does not run Next's CSS Modules loader; render the real table component
// while replacing only its stylesheet import.
const dataTable = load('src/components/ui/data-table.tsx', {
  './data-table.module.css': { __esModule: true, default: { table: 'jrm-data-table-test' } },
})
global.IS_REACT_ACT_ENVIRONMENT = true
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j }); return { promise, resolve, reject } }
const dataset = code => ({ source: 'prueba', basis: 'Salida programada', metrics: [], rows: [row(code)] })
test('interfaz oculta datos anteriores y descarta respuestas fuera de orden al cambiar el período', async () => {
  let query = new URLSearchParams({ section: 'transporte', f: JSON.stringify({ ...filters, compare: 'none' }) })
  const pending = []
  const Filter = () => React.createElement('div')
  const Panel = props => React.createElement('article', { 'data-code': props.data.rows[0]?.code }, props.data.rows[0]?.code)
  const canAccess = permission => permission === 'despacho'
  const Component = load('src/components/analytics/Reportes.tsx', {
    'next/navigation': { useRouter: () => ({ replace: () => {} }), useSearchParams: () => query },
    'lucide-react': { BarChart3: 'i', ChevronRight: 'i', Loader2: 'i', RefreshCw: 'i' },
    '@/hooks/usePermissions': { usePermissions: () => ({ hasAccess: canAccess, isLoaded: true }) },
    '@/lib/supabase/client': { createClient: () => ({ auth: { getUser: async () => ({ data: {} }) } }) },
    '@/lib/analytics/model': model,
    '@/lib/analytics/api': { filteredDataset: (_, d) => d, loadDataset: () => { const d = deferred(); pending.push(d); return d.promise } },
    './AnalysisPanel': { AnalysisPanel: Panel, MetricCard: () => null },
    './ReportFilters': { ReportFilters: Filter }, './DesempenoPanel': { __esModule: true, default: () => null },
  }).default
  let root
  await renderer.act(async () => { root = renderer.create(React.createElement(Component)) })
  await renderer.act(async () => { pending[0].resolve(dataset('OLD')) })
  assert.equal(root.root.findByType('article').props['data-code'], 'OLD')
  query = new URLSearchParams({ section: 'transporte', f: JSON.stringify({ ...filters, from: '2026-09-01', compare: 'none' }) })
  await renderer.act(async () => { root.update(React.createElement(Component)) })
  assert.equal(root.root.findAllByType('article').length, 0)
  const slow = pending[pending.length - 1]
  query = new URLSearchParams({ section: 'transporte', f: JSON.stringify({ ...filters, from: '2026-08-01', compare: 'none' }) })
  await renderer.act(async () => { root.update(React.createElement(Component)) })
  await renderer.act(async () => { pending[pending.length - 1].resolve(dataset('NEW')) })
  await renderer.act(async () => { slow.resolve(dataset('STALE')) })
  assert.equal(root.root.findByType('article').props['data-code'], 'NEW')
  query = new URLSearchParams({ section: 'transporte', f: JSON.stringify({ ...filters, from: '2026-07-01', compare: 'none' }) })
  await renderer.act(async () => { root.update(React.createElement(Component)) })
  await renderer.act(async () => { pending[pending.length - 1].reject(Error('Fuente no disponible')) })
  assert.equal(root.root.findAllByType('article').length, 0)
  assert.ok(root.root.findAllByProps({ role: 'alert' }).length)
  await renderer.act(async () => root.unmount())
})

const exp = load('src/lib/analytics/export.ts', { './model': model, '@/lib/apt/export': { exportAptXlsx: (name, sheets) => { global.analyticsExport = { name, sheets } } } })
test('Excel incluye filtros, fórmulas y todos los registros filtrados, no solo una página', async () => {
  const d = { ...dataset('X'), rows: Array.from({ length: 51 }, (_, i) => row(String(i))), metrics: model.aggregate('transporte', [row('1')]) }
  await exp.exportReport('excel', 'Transporte', { ...filters, plate: 'ABC123' }, d, dataset('Anterior'))
  assert.equal(global.analyticsExport.sheets.Detalle.length, 51)
  assert.equal(global.analyticsExport.sheets.Contexto[0].plate, 'ABC123')
  assert.equal(global.analyticsExport.sheets.Comparacion[0].Código, 'Anterior')
  assert.ok(global.analyticsExport.sheets.Indicadores[0].Fórmula)
  delete global.analyticsExport
})

for (const kind of ['Desempeno', 'Soporte']) {
  test(`formulario ${kind}: oculta textos del período anterior y no permite enviar durante la carga`, async () => {
    const pending = []
    const fake = {
      auth: { getUser: async () => ({ data: { user: { id: 'user' } }, error: null }) },
      rpc: () => { const d = deferred(); pending.push({ kind: 'kpis', ...d }); return d.promise },
      from: () => {
        const query = { select: () => query, eq: () => query, order: () => query,
          limit: () => { const d = deferred(); pending.push({ kind: 'history', ...d }); return d.promise },
          maybeSingle: () => { const d = deferred(); pending.push({ kind: 'current', ...d }); return d.promise },
        }
        return query
      },
    }
    const icons = new Proxy({}, { get: () => 'i' })
    const mocks = {
      'next/navigation': { useSearchParams: () => new URLSearchParams() },
      'next/link': { __esModule: true, default: 'a' }, 'lucide-react': icons,
      'sonner': { toast: { error: () => {}, success: () => {} } },
      '@/lib/supabase/client': { createClient: () => fake },
      '@/hooks/usePermissions': { usePermissions: () => ({ hasAccess: () => false }) },
      '@/lib/analytics/model': model, '@/lib/analytics/kpi': kpi,
      '@/lib/analytics/export': {}, '@/lib/kpi/reportReview': {}, '@/lib/fleet/api': { fmt: String },
      '@/components/kpi/kpiUi': { INFORME: {}, Indice: () => null, fecha: String, mesTxt: String },
      '@/components/kpi/MiAvance': {}, '@/components/kpi/TableroKpi': {},
      '@/components/ui/data-table': dataTable,
      './SoportePanel': { __esModule: true, default: () => null },
    }
    const Component = load(`src/components/analytics/${kind}Panel.tsx`, mocks)[`Informe${kind}`]
    let root
    await renderer.act(async () => { root = renderer.create(React.createElement(Component, { roles: [{ rol: 'DESPACHO' }], onEnviado: () => {} })) })
    const finish = async text => {
      await renderer.act(async () => {
        for (const d of pending.splice(0)) {
          if (d.kind === 'kpis') d.resolve({ data: { success: true, roles: [{ rol: 'DESPACHO' }] }, error: null })
          else if (d.kind === 'history') d.resolve({ data: [], error: null })
          else d.resolve({ data: { id: 'report', rol: 'DESPACHO', periodo: root.root.findAllByType('input').find(n => n.props.type === 'month').props.value + '-01', estado: 'ENVIADO', logros: text }, error: null })
        }
      })
    }
    await finish('Informe del primer mes')
    assert.equal(root.root.findAllByType('textarea')[0].props.value, 'Informe del primer mes')
    await renderer.act(async () => { root.root.findAllByType('input').find(n => n.props.type === 'month').props.onChange({ target: { value: '2026-07' } }) })
    assert.equal(root.root.findAllByType('textarea').length, 0)
    assert.equal(root.root.findAllByType('button').filter(n => n.props.children?.includes?.('Enviar informe')).length, 0)
    await finish('Informe del segundo mes')
    assert.equal(root.root.findAllByType('textarea')[0].props.value, 'Informe del segundo mes')
    await renderer.act(async () => root.unmount())
  })
}
