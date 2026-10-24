// Lector de los Excel del ERP (Actualizable Despacho y Stock Bodega Despacho) en src/lib/erp/parse.ts, con libros sintéticos.
const {test} = require('node:test')
const assert = require('node:assert/strict')
const {readFileSync} = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const XLSX = require('xlsx')

const file = path.join(__dirname, '../src/lib/erp/parse.ts')
const out = ts.transpileModule(readFileSync(file, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText
const mod = new Module(file)
mod.paths = Module._nodeModulePaths(path.dirname(file))
mod._compile(out, file)
const {parseErpWorkbooks, parseGuiasAdicionales} = mod.exports

const book = aoa => {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa, {cellDates: true}), 'Consulta1')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), 'Hoja1')
  return XLSX.write(wb, {type: 'array', bookType: 'xlsx'})
}
const HEAD = ['Nro_Contrato', 'Fecha_Contrato', 'Fecha_Vcto', 'Vigencia_Contrato', 'RUC_Cliente', 'Cliente', 'Nro_Documento', 'Tipo_Documento', 'Correlativo',
  'Secuencia', 'Cod_Producto', 'Producto', 'Color', 'Unidad', 'Cant_Contrato', 'Cant_Despachada', 'Cant_Reemplazada', 'Cant_Pendiente', 'Estado', 'Nro_Guias',
  'Guia_1', 'Cant_Guia_1', 'Guia_2', 'Cant_Guia_2', 'Guias_Adicionales', 'Fecha_Ult_Despacho', 'Fecha_Actualizacion', 'Tipo_Producto', 'Familia']
const upd = new Date(2026, 9, 23, 16, 51, 13)

test('Actualizable: líneas, guías (columnas y adicionales), fechas y corte del ERP', () => {
  const rows = [HEAD,
    [15304, new Date(2024, 9, 31), new Date(2025, 2, 5), 'S', 20100617332, 'RINTI S A', '15304-S036', 'SUBCONTRATO DE VENTAS', 8891, 1, '56p1', 'TUBO PUERTA', null, 'UND',
      10, 9, 0, 1, 'PARCIAL', 3, 'T001-00006579', 4, 'ND99-00000133', 2, 'T001-00001564 (3.00)', new Date(2026, 8, 7), upd, 'PRODUCTO TERMINADO', 'RACK'],
    [15304, new Date(2024, 9, 31), new Date(2025, 2, 5), 'S', 20100617332, 'RINTI S A', '15304', 'CONTRATO DE VENTAS', 8890, 1, '56p2', 'PUERTA', null, 'UND',
      5, 0, 0, 5, 'SIN DESPACHO', 0, null, null, null, null, null, null, upd, 'PRODUCTO TERMINADO', 'RACK'],
    [15304, null, null, null, null, null, '15304', null, null, 1, '56p2', 'REPETIDA', null, 'UND', 1, 0, 0, 1, null, 0],
  ]
  const res = parseErpWorkbooks([{name: 'Actualizable_Despacho.xlsx', data: book(rows)}])
  assert.deepEqual(res.errors, [])
  const f = res.files[0]
  assert.equal(f.kind, 'CONTRATOS')
  assert.equal(f.rows.length, 2)
  assert.equal(f.cutAt, '2026-10-23T16:51:13-05:00')
  const l = f.rows[0]
  assert.equal(l.nro_contrato, '15304')
  assert.equal(l.ruc, '20100617332')
  assert.equal(l.fecha_contrato, '2024-10-31')
  assert.equal(l.fecha_ult_despacho, '2026-09-07')
  assert.deepEqual(l.guias.map(g => [g.g, g.c]), [['T001-00006579', 4], ['ND99-00000133', 2], ['T001-00001564', 3]])
  assert.equal(f.stats.despachos, 3)
  assert.equal(f.stats.duplicadas, 1)
  assert.ok(!f.stats.guias_no_cuadran && !f.stats.nro_guias_distinto, 'las guías cuadran con lo despachado y con Nro_Guias')
})

test('Actualizable: avisa cuando las guías no cuadran o falta Nro_Guias', () => {
  const rows = [HEAD, [1, null, null, 'S', 1, 'C', '1', 'CONTRATO DE VENTAS', 1, 1, 'X', 'X', null, 'UND', 5, 5, 0, 0, 'COMPLETO', 2, 'T001-1', 4, null, null, null, null, upd]]
  const f = parseErpWorkbooks([{name: 'a.xlsx', data: book(rows)}]).files[0]
  assert.equal(f.stats.guias_no_cuadran, 1)
  assert.equal(f.stats.nro_guias_distinto, 1)
  assert.equal(f.warnings.length, 2)
})

test('Guías adicionales con miles y espacios', () => {
  assert.deepEqual(parseGuiasAdicionales('T001-00001564 (1,280.00), T001-00001573 (1248.00),T005-9 ( 2 )'),
    [{g: 'T001-00001564', c: 1280}, {g: 'T001-00001573', c: 1248}, {g: 'T005-9', c: 2}])
  assert.deepEqual(parseGuiasAdicionales(null), [])
})

test('Stock: lote como texto, filas sin lote y stock negativo; archivo no reconocido y duplicado', () => {
  const head = ['Bodega', 'Cod_Producto', 'Producto', 'Tipo_Producto', 'Unidad', 'Lote', 'Stock', 'Stock_Falla', 'Stock_Comprometido', 'Requerimiento', 'Orden_Compra',
    'Stock_Minimo', 'Stock_Reposicion', 'Dias_Compra', 'Familia', 'SubFamilia', 'Tipo', 'SubTipo', 'Peso_Unitario', 'Peso_Total', 'Fecha_Actualizacion']
  const stock = book([head,
    ['647-04  ALM PT', 'APP.45', 'ADAPTADOR', 'PRODUCTO TERMINADO', 'UND', 15696, 161, 0, 4655, 0, 0, 0, 0, 0, '', '', '', '', 1.219, 196.259, new Date(2026, 9, 23, 16, 32, 52)],
    ['ST-VENTAS-IMD', '503.01.011', 'PERNO', 'MAT.AUX', 'CIEN', '16497-S001', 2.75, 0, 0, 0, 0, 0, 0, 0, '', '', '', '', 0.048, 0.132, new Date(2026, 9, 23, 16, 32, 52)],
    ['ST-VENTAS-IMD', '30BA5', 'TUBO', 'MAT.AUX', 'UND', null, -1, 0, 0, 0, 0, 0, 0, 0, '', '', '', '', 1, -1, new Date(2026, 9, 23, 16, 32, 52)],
  ])
  const res = parseErpWorkbooks([{name: 'Stock.xlsx', data: stock}, {name: 'Otro.xlsx', data: book([['A', 'B'], [1, 2]])}, {name: 'Stock2.xlsx', data: stock}])
  const f = res.files[0]
  assert.equal(f.kind, 'STOCK')
  assert.equal(f.rows.length, 3)
  assert.equal(f.rows[0].lote, '15696')
  assert.equal(f.rows[0].linea, 2)
  assert.equal(f.rows[1].unidad, 'CIEN')
  assert.equal(f.stats.sin_lote, 1)
  assert.equal(f.stats.stock_negativo, 1)
  assert.equal(res.errors.length, 2, 'avisa el archivo no reconocido y el Stock repetido')
})
