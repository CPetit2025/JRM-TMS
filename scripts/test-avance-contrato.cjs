const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const Module = require('node:module')
const file = path.resolve(__dirname, '../src/lib/inventario/avance-contrato.ts')
const mod = new Module(file, module)
mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, file)
const { buildAvance, filtrarAvance, totalAvance, FILTRO_INICIAL } = mod.exports

const linea = (item, producto, contratado, despachado, extra = {}) => ({ item, documento: item.slice(0, 5), secuencia: 1, producto, glosa: 'G', unidad: 'UND',
  contratado, despachado, pendiente: contratado - despachado, estado: null, guias: null, fecha_contrato: null, ultimo_despacho: null, ...extra })
const prod = (producto, b647, b540, bst, extra = {}) => ({ producto, glosa: 'G', unidad: 'UND', lotes: [], guias: 0, ingresado: 10, producido: 10, despachado: 0, otras_salidas: 0, diferencia: 0,
  stock_647: b647, stock_540: b540, stock_st: bst, stock: b647 + b540 + bst, stock_kg: 0, inferido: 0, ingresado_kg: 50, despachado_kg: 0, ultimo_ingreso: null, ultima_salida: null, dias_apt: null, ...extra })

test('el stock de un ID compartido se reparte sin contarse dos veces (647, luego 540 y ST)', () => {
  const rows = buildAvance([linea('16101-001', 'A', 10, 4, { peso_unit: 2 }), linea('16101-002', 'A', 5, 0)], [prod('A', 3, 2, 4)])
  assert.deepEqual(rows[0].apt, [3, 2, 1]); assert.equal(rows[0].porProducir, 0)
  assert.deepEqual(rows[1].apt, [0, 0, 3]); assert.equal(rows[1].porProducir, 2)
  assert.equal(rows[0].peso, 2); assert.equal(rows[0].pesoFuente, 'ERP')
  assert.equal(rows[1].peso, 5); assert.equal(rows[1].pesoFuente, 'APT') // 50 kg / 10 und
  assert.equal(rows[0].estado, 'PARCIAL'); assert.equal(rows[1].estado, 'PENDIENTE')
})

test('otra unidad en el APT no se asigna; sin peso queda marcado; los totales en TN ignoran lo sin peso', () => {
  const rows = buildAvance([linea('16101-001', 'B', 8, 8), linea('16101-002', 'C', 6, 0)], [prod('C', 6, 0, 0, { unidad: 'CIEN' })])
  assert.equal(rows[0].estado, 'COMPLETO'); assert.equal(rows[0].peso, null)
  assert.equal(rows[1].unidadDistinta, true); assert.equal(rows[1].enApt, 0); assert.equal(rows[1].porProducir, 6)
  const t = totalAvance(rows); assert.equal(t.sinPeso, 2); assert.equal(t.tContratado, 0); assert.equal(t.contratado, 14); assert.equal(t.mixta, false)
  assert.equal(totalAvance(buildAvance([linea('16101-003', 'E', 2, 0, { unidad: 'CIEN' }), linea('16101-004', 'F', 3, 0)], [])).mixta, true)
})

test('filtros: solo con saldo por defecto, bodega, situación y rango de avance', () => {
  const rows = buildAvance([linea('16101-001', 'A', 10, 10), linea('16101-002', 'A', 10, 5), linea('16101-003', 'D', 4, 0)], [prod('A', 0, 5, 0)])
  assert.deepEqual(filtrarAvance(rows, FILTRO_INICIAL).map(r => r.item), ['16101-002', '16101-003'])
  assert.deepEqual(filtrarAvance(rows, { ...FILTRO_INICIAL, bodega: '540' }).map(r => r.item), ['16101-002'])
  assert.deepEqual(filtrarAvance(rows, { ...FILTRO_INICIAL, situacion: 'LISTO' }).map(r => r.item), ['16101-002'])
  assert.deepEqual(filtrarAvance(rows, { ...FILTRO_INICIAL, soloSaldo: false, min: '100' }).map(r => r.item), ['16101-001'])
})

test('Excel: dos hojas horizontales, sin notas ni outlinePr (con ellos Excel no abre el archivo)', async () => {
  const xf = path.resolve(__dirname, '../src/lib/inventario/avance-contrato-excel.ts')
  const xm = new Module(xf, module)
  xm.require = n => (n === './avance-contrato' ? mod.exports : require(n))
  xm._compile(ts.transpileModule(readFileSync(xf, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, xf)
  const ExcelJS = require('exceljs'), JSZip = require('jszip')
  const todas = buildAvance([linea('16101-001', 'A', 10, 4, { peso_unit: 2 }), linea('16101-002', 'E', 2, 0, { unidad: 'PAR' })], [prod('A', 3, 2, 4)])
  const hoja = xm.exports.buildHoja(filtrarAvance(todas, FILTRO_INICIAL), todas, { ot: '16101', cliente: 'X', corte: null, filtros: ['Solo con saldo'], generado: new Date() })
  const buf = await (await xm.exports.buildAvanceWorkbook(ExcelJS, hoja)).xlsx.writeBuffer()
  const zip = await JSZip.loadAsync(buf), sheet1 = await zip.file('xl/worksheets/sheet1.xml').async('string')
  assert.ok(!sheet1.includes('<outlinePr')); assert.equal(zip.file('xl/comments1.xml'), null)
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf)
  assert.deepEqual(wb.worksheets.map(w => w.name), ['Avance por ítem', 'Cumplimiento por lote'])
  assert.ok(wb.worksheets.every(w => w.pageSetup.orientation === 'landscape'))
  assert.equal(wb.worksheets[0].getCell('A13').value, 16101)
  assert.match(String(wb.worksheets[0].autoFilter && (wb.worksheets[0].autoFilter.ref || JSON.stringify(wb.worksheets[0].autoFilter))), /15|A11:/) // llega a las filas de datos
  const mix = buildAvance([linea('16101-001', 'P', 10, 5), linea('16101-002', 'Q', 2, 1, { unidad: 'PAR' })], [])
  const lote = xm.exports.buildHoja(mix, mix, { ot: '16101', cliente: null, corte: null, filtros: [], generado: new Date() }).lotes[0]
  assert.equal(lote.medida, null); assert.equal(lote.despachado, null); assert.equal(lote.pct, null)
})

test('conItems: ítems del lote más específico; sin coincidencia de lote, todos los del producto', () => {
  const { conItems } = mod.exports
  const st = (lote, producto) => ({ bodega: '647-04 ALM PT', kind: 'apt', producto, glosa: null, lote, ot: null, cliente: null, unidad: 'UND', qty: 1, kg: 1, kg_conocido: true,
    fecha_ingreso: null, fecha_origen: null, dias_bodega: null, dias_origen: null, inferido: 0, foto: 0, capas: 1 })
  const ls = [linea('16188-001', 'A', 10, 4, { documento: '16188', ultimo_despacho: '2026-10-01' }), linea('16188-002', 'A', 5, 5, { documento: '16188-S002', ultimo_despacho: '2026-11-01' }),
    linea('16188-003', 'B', 7, 2, { documento: '16188', ultimo_despacho: '2026-09-01' }), linea('16188-004', 'B', 3, 0, { documento: '16188' })]
  const [madre, sub, b, sinItem] = conItems([st('16188', 'A'), st('16188-S002D', 'A'), st('16188-E002', 'B'), st('16188', 'Z')], ls)
  assert.equal(madre.items, '16188-001'); assert.equal(madre.pendiente, 6); assert.equal(madre.despachado, 4)
  assert.equal(sub.items, '16188-002'); assert.equal(sub.pendiente, 0); assert.equal(sub.ultimo_despacho, '2026-11-01')
  assert.equal(b.items, '16188-003, 16188-004'); assert.equal(b.pendiente, 8); assert.equal(b.ultimo_despacho, '2026-09-01')
  assert.equal(sinItem.items, ''); assert.equal(sinItem.pendiente, null)
})

test('conItems: 16188-S1 = 16188-S001 (como erp_doc_key) y S1 no toma S10', () => {
  const { conItems } = mod.exports
  const st = lote => ({ bodega: '647', kind: 'apt', producto: 'A', glosa: null, lote, ot: null, cliente: null, unidad: 'UND', qty: 1, kg: 1, kg_conocido: true,
    fecha_ingreso: null, fecha_origen: null, dias_bodega: null, dias_origen: null, inferido: 0, foto: 0, capas: 1 })
  const ls = [linea('16188-001', 'A', 10, 4, { documento: '16188' }), linea('16188-002', 'A', 5, 5, { documento: '16188-S1' })]
  const [s1, s10] = conItems([st('16188-S001D'), st('16188-S10')], ls)
  assert.equal(s1.items, '16188-002'); assert.equal(s10.items, '16188-001')
})

test('motivosSincerar: sin stock no es candidato; señales de despachado, avance y antigüedad', () => {
  const { motivosSincerar } = mod.exports
  const c = { despachado_kg: 0, ingresado_kg: 10, avance_pct: 50, dias_stock: 10, ultimo_ingreso: '2026-11-01', ultima_salida: null }
  const corte = '2026-11-27'
  assert.deepEqual(motivosSincerar({ ...c, despachado_kg: 99 }, 0, corte), [])
  assert.deepEqual(motivosSincerar(c, 5, corte), [])
  assert.deepEqual(motivosSincerar({ ...c, despachado_kg: 20, avance_pct: 100 }, 5, corte), ['Despachado > ingresado', 'Avance 100 %'])
  assert.deepEqual(motivosSincerar({ ...c, ultimo_ingreso: '2025-01-10', ultima_salida: '2025-06-01' }, 5, corte), ['Sin movimiento > 1 año'])
  assert.deepEqual(motivosSincerar({ ...c, dias_stock: 400 }, 5, corte), ['Stock > 1 año'])
  assert.deepEqual(motivosSincerar({ ...c, ultimo_ingreso: null }, 5, corte), ['Sin movimientos registrados'])
})
