const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
function load(file, mocks = {}) {
  const mod = new Module(file, module)
  mod.paths = module.paths
  const normal = mod.require.bind(mod)
  mod.require = name => Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name] : normal(name)
  mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file)
  return mod.exports
}
const analysis = load(path.resolve(__dirname, '../src/lib/ai/apt-analysis.ts'))
const summary = { success: true, meta: { cutoff: '2026-10-10', version: 'v1', model_fresh: true }, kpis: { stock_tn: 20, weighted_age_days: null, dispatch_tn: 8 }, quality: { missing_weight_rows: 3 }, total: 2, rows: [{}] }

test('rejects unknown, legacy, impossible dates and oversized filters instead of broadening the scope', () => {
  for (const filters of [{ ingreso_desde: '2026-10-01' }, { cutoff: '2026-02-30' }, { desde: '2026-10-11', hasta: '2026-10-01' }, { almacen: 'MONTACARGA' }, { ot: ['16339'] }, { limit: 101 }, { clientes: Array(26).fill('A') }, { desde: '2024-01-01', hasta: '2026-01-01' }]) assert.throws(() => analysis.validateAptAnalysisFilters(filters))
  assert.deepEqual(analysis.validateAptAnalysisFilters({ ot: ' 16339 ', clientes: ['A', 'A'] }), { ot: '16339', clientes: ['A'] })
})
test('controlled RPC preserves filters, full totals and unknown metrics without invented zeros', async () => {
  const calls = []
  const result = await analysis.getAptOperationalAnalysis({ rpc: async (name, args) => { calls.push({ name, args }); return { data: summary } } }, { ot: '16339', cutoff: '2026-10-10' })
  assert.deepEqual(calls, [{ name: 'apt_operational_summary', args: { p: { ot: '16339', cutoff: '2026-10-10' } } }])
  assert.equal(result.sampleTruncated, true)
  assert.match(analysis.formatAptAnalysisReport(result), /Antigüedad ponderada: No evaluable/)
  assert.match(analysis.formatAptAnalysisReport(result), /no constituye conciliación física/)
})
test('comparison conserves entity scope and calculates deltas, with zero denominators remaining unknown', async () => {
  let index = 0; const calls = []
  const result = await analysis.getAptOperationalAnalysis({ rpc: async (_, args) => { calls.push(args.p); return { data: index++ ? { ...summary, kpis: { stock_tn: 0, dispatch_tn: 4 } } : summary } } }, { ot: '16339', almacen: '647' }, { cutoff: '2026-09-30' })
  assert.equal(calls[1].ot, '16339'); assert.equal(calls[1].almacen, '647')
  assert.equal(result.comparison.deltas.stock_tn.percent, null)
  assert.equal(result.comparison.deltas.dispatch_tn.percent, 100)
  await assert.rejects(() => analysis.getAptOperationalAnalysis({ rpc: async () => ({ data: summary }) }, {}, { ot: 'other' }))
})
test('changed versions and stale models suppress numerical comparison conclusions', async () => {
  for (const meta of [{ version: 'v2', model_fresh: true }, { version: 'v1', model_fresh: false }]) {
    let index = 0
    const result = await analysis.getAptOperationalAnalysis({ rpc: async () => ({ data: index++ ? { ...summary, meta } : summary }) }, {}, { cutoff: '2026-09-30' })
    assert.deepEqual(result.comparison.deltas, {})
  }
})
test('RPC failures do not expose database details or fabricated metrics', async () => {
  await assert.rejects(() => analysis.getAptOperationalAnalysis({ rpc: async () => ({ error: { message: 'private schema SQL text' } }) }, {}), error => !error.message.includes('private schema'))
})

function endpoint({ authorized = true, quota = true, signedIn = true } = {}) {
  const calls = []
  const identity = { supabase: { from: () => ({ select: () => ({ eq: async () => ({ data: [{ id: 'site1', name: 'Site' }] }) }) }), rpc: async (name, args) => { calls.push({ name, args }); return { data: summary } } }, employeeType: 'OFFICE', isAdmin: false, canPrepareMaintenance: () => false, canUseAi: () => authorized }
  const route = load(path.resolve(__dirname, '../src/app/api/jrm-ai/route.ts'), {
    '@/lib/ai/apt-analysis': analysis,
    '@/lib/ai/auth': { getAiIdentity: async () => signedIn ? identity : null, reserveAiRequest: async () => quota },
    '@/lib/ai/tools': { toolAccess: { get_apt_operational_analysis: { scope: 'inventarios', modules: ['apt'] } }, toolDefinitions: [{ name: 'get_apt_operational_analysis' }] },
    '@/lib/ai/audit': { writeAiAudit: async () => {} }, '@/lib/ai/actions': {},
  })
  return { route, calls }
}
const request = context => new Request('http://localhost/api/jrm-ai', { method: 'POST', body: JSON.stringify({ message: 'Analiza APT', context }) })
test('endpoint enforces identity, AI permissions and quota before operational reads', async () => {
  for (const [options, status] of [[{ signedIn: false }, 403], [{ authorized: false }, 403], [{ quota: false }, 429]]) {
    const { route, calls } = endpoint(options)
    assert.equal((await route.POST(request({ path: '/apt' }))).status, status)
    assert.equal(calls.length, 0)
  }
})
test('endpoint rejects legacy and unsupported context without querying', async () => {
  for (const context of [{ path: '/apt', aptFilters: { evil: 'sql' } }, { path: '/apt', aptLegacyFilters: { solo_saldo: true } }]) {
    const { route, calls } = endpoint()
    assert.equal((await route.POST(request(context))).status, 400)
    assert.equal(calls.length, 0)
  }
})
test('without provider APT returns grounded calculated mode, source evidence and no proposals', async () => {
  const saved = ['OPENAI_API_KEY', 'GEMINI_API_KEY'].map(key => [key, process.env[key]])
  try {
    for (const [key] of saved) delete process.env[key]
    const { route, calls } = endpoint()
    const response = await route.POST(request({ path: '/apt', aptFilters: { ot: '16339' } }))
    const body = await response.json()
    assert.equal(response.status, 200); assert.equal(body.mode, 'calculated'); assert.deepEqual(body.proposals, [])
    assert.equal(body.evidence.filters.ot, '16339'); assert.equal(body.evidence.filters.cutoff, '2026-10-10'); assert.equal(calls.length, 1)
    assert.match(body.answer, /no interpreta preguntas libres/)
  } finally { for (const [key, value] of saved) if (value === undefined) delete process.env[key]; else process.env[key] = value }
})

const scopedSummary = { ...summary, meta: { ...summary.meta, composition_available: true, flow_rebuilt_at: '2026-10-10T10:00:00Z' }, rows: [{ almacen: '647', lote: '16339-E014' }], total: 1 }
test('registered causes and observations are restricted to exact summary rows, not all OT or client data', async () => {
  const calls = []
  const result = await analysis.getAptOperationalAnalysis({ rpc: async (name, args) => {
    calls.push({ name, args })
    if (name === 'apt_operational_summary') return { data: scopedSummary }
    if (name === 'apt_readiness_list') return { data: { success: true, rows: [{ almacen: '647', lote: '16339-E014', producto: '*', status: 'BLOQUEADO', reason: 'Esperando liberación', responsible_name: 'Supervisor', next_action: 'Validar liberación', updated_at: '2026-10-10T11:00:00Z' }, { almacen: '647', lote: 'OTHER', producto: '*', reason: 'private' }] } }
    return { data: { success: true, model_fresh: true, documentary_available: true, total: 2, rows: [{ almacen: '647', lote: '16339-E014', producto: 'P1', cutoff: '2026-10-10', source: 'FISICO', status: 'DIFERENCIA', difference_kg: 2 }, { almacen: '647', lote: '16339-E014-X', cutoff: '2026-10-10', notes: 'private sibling' }] } }
  } }, { ot: '16339', clientes: ['Cliente autorizado'] })
  assert.deepEqual(calls[1].args.p_keys, [{ almacen: '647', lote: '16339-E014', producto: '*' }])
  assert.deepEqual(calls[2].args.p, { cutoff: '2026-10-10', almacen: '647', lote: '16339-E014', limit: 100, offset: 0 })
  assert.equal(result.registeredEvidence.readiness.rows[0].status, 'BLOQUEADO')
  assert.equal(result.registeredEvidence.readiness.rows[0].responsible_name, 'Supervisor')
  assert.equal(result.registeredEvidence.reconciliation.rows.length, 1)
  assert.equal(result.registeredEvidence.reconciliation.certifies_full_inventory, false)
  assert.ok(!JSON.stringify(result.registeredEvidence).includes('private'))
})
test('old reviews are NO_EVALUADO and historical causes retained only as evidence requiring revalidation', async () => {
  const result = await analysis.getAptOperationalAnalysis({ rpc: async name => {
    if (name === 'apt_operational_summary') return { data: scopedSummary }
    if (name === 'apt_readiness_list') return { data: { success: true, rows: [{ almacen: '647', lote: '16339-E014', producto: '*', status: 'DISPONIBLE', reason: 'Validado antes de nueva carga', updated_at: '2026-10-09T11:00:00Z' }] } }
    return { data: { success: true, rows: [], total: 0 } }
  } }, {})
  const review = result.registeredEvidence.readiness.rows[0]
  assert.equal(review.status, 'NO_EVALUADO'); assert.equal(review.registered_status, 'DISPONIBLE'); assert.equal(review.review_current, false)
  assert.match(analysis.formatAptAnalysisReport(result), /Requiere revisión/)
})
test('optional review permission failures are explicit without failing the authorized summary', async () => {
  const result = await analysis.getAptOperationalAnalysis({ rpc: async name => name === 'apt_operational_summary' ? { data: scopedSummary } : { error: { message: 'sensitive permission SQL' } } }, {})
  assert.equal(result.summary.kpis.stock_tn, 20)
  assert.equal(result.registeredEvidence.readiness.available, false)
  assert.equal(result.registeredEvidence.reconciliation.available, false)
  assert.ok(!JSON.stringify(result).includes('sensitive permission SQL'))
})
test('historical snapshot never reuses current readiness and observation requests remain cutoff scoped', async () => {
  const calls = []
  const result = await analysis.getAptOperationalAnalysis({ rpc: async (name, args) => {
    calls.push({ name, args })
    return name === 'apt_operational_summary' ? { data: { ...scopedSummary, meta: { ...scopedSummary.meta, composition_available: false } } } : { data: { success: true, rows: [], total: 0 } }
  } }, {})
  assert.ok(!calls.some(call => call.name === 'apt_readiness_list'))
  assert.equal(result.registeredEvidence.readiness.reason, 'CORTE_HISTORICO_SIN_REVISION_HISTORICA')
  assert.equal(calls[1].args.p.cutoff, '2026-10-10')
})
test('observation request fanout is bounded and explicitly marked sampled', async () => {
  const calls = []
  const result = await analysis.getAptOperationalAnalysis({ rpc: async (name, args) => {
    calls.push({ name, args })
    if (name === 'apt_operational_summary') return { data: { ...scopedSummary, rows: Array.from({ length: 11 }, (_, i) => ({ almacen: '647', lote: `OT${i}` })), total: 20 } }
    return { data: { success: true, rows: [], total: 0 } }
  } }, {})
  assert.equal(calls.filter(call => call.name === 'apt_stock_reconciliation').length, 10)
  assert.equal(result.registeredEvidence.reconciliation.keysExcludedByLimit, 1)
  assert.equal(result.registeredEvidence.reconciliation.sampleTruncated, true)
})
