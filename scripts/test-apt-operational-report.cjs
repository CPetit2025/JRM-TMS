const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const file = path.resolve(__dirname, '../src/lib/apt/operationalReport.ts')
const compiled = new Module(file, module)
compiled.paths = module.paths
const pdfCalls = []
const actualRequire = compiled.require.bind(compiled)
compiled.require = name => name === 'jspdf' ? { jsPDF: class {
  pages = 1
  setFillColor() {} rect() {} setTextColor() {} setFont() {} setFontSize() {} setDrawColor() {} setLineWidth() {} line() {} circle() {}
  text(value) { pdfCalls.push(value) } splitTextToSize(value) { return [value] }
  addPage() { this.pages++ } getNumberOfPages() { return this.pages } setPage() {}
  save(name) { pdfCalls.push(name) }
} } : actualRequire(name)
compiled._compile(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, file)
const { buildOperationalReport, operationalReportValue, operationalReportEmail, operationalReportSheets, exportOperationalReport, loadCompleteOperationalReportSource } = compiled.exports
const fixture = () => ({
  schema_version: 1, filters: { ot: '16339', desde: '2026-10-01', hasta: '2026-10-10' },
  meta: { cutoff: '2026-10-10', desde: '2026-10-01', hasta: '2026-10-10', data_min: '2026-01-01', data_max: '2026-10-10', model_fresh: true, flow_rebuilt_at: '2026-10-11T01:00:00Z', latest_applied_at: '2026-10-11T00:00:00Z', calculation_basis: 'DOCUMENTAL_RECONSTRUIDO', composition_available: true, physical_reconciliation: 'NO_VERIFICADA', age_basis: 'ORIGEN', alert_days: 30, version: 'snapshot-v1' },
  kpis: { stock_tn: 50, inferred_opening_tn: 5, known_origin_stock_tn: 45, unknown_origin_stock_tn: 5, weighted_age_days: 20, stock_tn_days: 900, production_tn: 100, dispatch_tn: 90, consumption_tn: 20, returns_tn: 5, average_stock_tn: 50, turnover: 1.8, observed_days: 10 },
  quality: { missing_weight_rows: 2, temporal_anomaly_rows: 1, negative_balance_rows: 0 },
  coverage: [{ kind: 'ENTRADA', desde: '2026-01-01', hasta: '2026-10-10', rows: 50, missing_weight_rows: 2 }],
  rows: [{ almacen: '647', lote: '16339-E014', cliente: '=HYPERLINK("bad")', stock_tn: 3, inferred_opening_tn: 0, age_days: 5, stock_tn_days: 15 }],
  series: [{ fecha: '2026-10-10', stock_tn: 50, production_tn: 10, dispatch_tn: 9 }],
  warehouses: [{ almacen: '647', stock_tn: 50, inferred_opening_tn: 5 }], total: 20, limit: 25, offset: 0,
})
const build = (source = fixture(), kind = 'executive') => buildOperationalReport(source, { ot: 'incorrect-client-value' }, kind, new Date('2026-10-11T02:00:00Z'))

test('report keeps server-wide totals and authoritative filters separate from paginated detail', () => {
  const r = build()
  assert.equal(r.metrics.find(m => m.label === 'Saldo documental reconstruido').value, 50)
  assert.equal(r.rows[0].stock_tn, 3)
  assert.match(r.detailScope, /Detalle parcial: 1 de 20/)
  assert.match(r.filters, /ot: 16339/)
  assert.ok(!r.filters.includes('incorrect-client-value'))
  assert.equal(r.version, 'snapshot-v1')
  assert.match(r.generatedAt, /10\/10\/2026/)
  assert.ok(r.limitations.some(l => l.includes('no sustituye la conciliación física')))
})
test('null historical indicators remain non-evaluable, freshness and data defects produce evidence', () => {
  const src = fixture(); src.meta.model_fresh = false; src.meta.composition_available = false
  src.meta.age_basis = 'NO_DISPONIBLE'; src.kpis.weighted_age_days = null; src.kpis.inferred_opening_tn = null
  src.kpis.unknown_origin_stock_tn = null; src.kpis.turnover = null; src.quality.negative_balance_rows = 3
  const r = build(src)
  assert.equal(operationalReportValue(null), 'No evaluable')
  assert.equal(operationalReportValue(NaN), 'No evaluable')
  assert.equal(operationalReportValue(0, 'TN'), '0 TN')
  assert.equal(r.metrics.find(m => m.label.includes('Antigüedad ponderada')).value, null)
  for (const expected of ['Modelo pendiente', 'Composición histórica', 'Movimientos con peso', 'Secuencia temporal', 'Saldos negativos']) assert.ok(r.findings.some(f => f.title.startsWith(expected)), expected)
  assert.ok(!r.findings.some(f => f.title.includes('Apertura pendiente')))
})
test('executive truncation and operational complete scope are accurately labeled; snapshot detaches mutable rows', () => {
  const src = fixture(); src.rows = Array.from({ length: 12 }, (_, i) => ({ ...src.rows[0], lote: `OT-${i}` })); src.total = 12
  const exec = build(src), ops = build(src, 'operational')
  assert.equal(exec.rows.length, 10); assert.match(exec.detailScope, /10 de 12/)
  assert.equal(ops.rows.length, 12); assert.match(ops.detailScope, /Detalle completo/)
  src.rows[0].lote = 'changed'; src.series[0].stock_tn = 999
  assert.equal(ops.rows[0].lote, 'OT-0'); assert.equal(ops.series[0].stock_tn, 50)
  src.offset = 12; src.total = 24
  assert.match(build(src, 'operational').detailScope, /posiciones 13 a 24/)
  assert.throws(() => build({ ...src, schema_version: 2 }), /Versión/)
  assert.throws(() => build({ ...src, offset: -1 }), /Alcance/)
})
test('email draft includes evidence, scope and limitations without duplicating personal signature or sending', () => {
  const email = operationalReportEmail(build())
  assert.match(email.subject, /Corte 2026-10-10/)
  assert.match(email.body, /GERENCIA DE LOGÍSTICA/)
  assert.match(email.body, /Acción:/)
  assert.match(email.body, /Detalle parcial/)
  assert.match(email.body, /Atentamente,$/)
  assert.ok(!email.body.includes('cpetit@'))
  assert.ok(!email.body.includes('https://'))
})
test('Excel export preserves numeric units, null unknowns and potentially dangerous labels as plain strings', async () => {
  const r = build(); r.metrics[1].value = null
  const sheets = operationalReportSheets(r)
  assert.equal(sheets.Indicadores[0].Valor, 50)
  assert.equal(sheets.Indicadores[1].Valor, null)
  assert.match(sheets.Contexto.find(r => r.Campo === 'Detalle').Valor, /Detalle parcial/)
  let blob, filename
  const originalDocument = global.document, originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL
  global.document = { createElement: () => ({ set download(value) { filename = value }, click() {} }) }
  URL.createObjectURL = value => { blob = value; return 'blob:test' }; URL.revokeObjectURL = () => {}
  try {
    await exportOperationalReport(r, 'excel')
    const { Workbook } = require('exceljs'); const workbook = new Workbook()
    await workbook.xlsx.load(await blob.arrayBuffer())
    assert.equal(filename, 'JRM_APT_executive_2026-10-10.xlsx')
    assert.equal(workbook.getWorksheet('Detalle').getCell('C2').value, '=HYPERLINK("bad")')
    assert.equal(workbook.getWorksheet('Detalle').getCell('C2').type, 3)
    assert.equal(workbook.getWorksheet('Indicadores').getCell('B2').value, 50)
    assert.equal(workbook.getWorksheet('Indicadores').getCell('B3').value, null)
    assert.equal(workbook.getWorksheet('Contexto').getCell('B4').value, '2026-10-10')
    assert.equal(workbook.getWorksheet('Cobertura').getCell('A2').value, 'ENTRADA')
  } finally { global.document = originalDocument; URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke }
})
test('PDF states source, version, paginated scope and evidence with an explicit non-evaluable value', async () => {
  pdfCalls.length = 0
  const r = build(); r.metrics[1].value = null
  await exportOperationalReport(r, 'pdf')
  const content = pdfCalls.join('\n')
  for (const expected of ['apt_operational_summary', 'snapshot-v1', 'Detalle parcial', 'No evaluable', 'Hallazgos y acciones', 'JRM_APT_executive_2026-10-10.pdf']) assert.ok(content.includes(expected), expected)
})


test('full report fetch pins effective dates, loads sequential pages and retains original totals', async () => {
  const src = fixture(); src.total = 205; src.offset = 100
  const offsets = [], progress = []
  const complete = await loadCompleteOperationalReportSource(src, async (filters, limit, offset) => {
    assert.equal(filters.cutoff, src.meta.cutoff); assert.equal(filters.desde, src.meta.desde); assert.equal(filters.hasta, src.meta.hasta); assert.equal(limit, 100)
    offsets.push(offset)
    return { ...src, offset, rows: Array.from({ length: Math.min(limit, src.total - offset) }, (_, n) => ({ ...src.rows[0], lote: `OT-${offset + n}` })) }
  }, (loaded, total) => progress.push([loaded, total]))
  assert.deepEqual(offsets, [0, 100, 200]); assert.deepEqual(progress.at(-1), [205, 205])
  assert.equal(complete.rows.length, 205); assert.equal(complete.offset, 0); assert.equal(complete.kpis.stock_tn, 50)
  assert.match(build(complete, 'operational').detailScope, /Detalle completo/)
})
test('full report rejects changed snapshots, duplicates, broken pagination and explicit excessive scope', async () => {
  const src = fixture(); src.total = 2
  await assert.rejects(loadCompleteOperationalReportSource(src, async () => ({ ...src, meta: { ...src.meta, version: 'changed' } })), /información cambió/)
  await assert.rejects(loadCompleteOperationalReportSource(src, async () => ({ ...src, kpis: { ...src.kpis, stock_tn: 999 } })), /información cambió/)
  await assert.rejects(loadCompleteOperationalReportSource(src, async () => ({ ...src, total: 3 })), /información cambió/)
  await assert.rejects(loadCompleteOperationalReportSource(src, async () => ({ ...src, offset: 1 })), /paginación/)
  await assert.rejects(loadCompleteOperationalReportSource(src, async () => ({ ...src, rows: [] })), /paginación/)
  await assert.rejects(loadCompleteOperationalReportSource(src, async () => ({ ...src, rows: [src.rows[0], src.rows[0]] })), /repetido/)
  let called = false
  await assert.rejects(loadCompleteOperationalReportSource({ ...src, total: 10001 }, async () => { called = true; return src }), /hasta 10000/)
  assert.equal(called, false)
})
