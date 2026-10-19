// Lector de los reportes del ERP para el inventario multi-almacén (src/lib/inventario/parse.ts), con libros sintéticos.
const {test} = require('node:test')
const assert = require('node:assert/strict')
const {readFileSync} = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const XLSX = require('xlsx')

const file = path.join(__dirname, '../src/lib/inventario/parse.ts')
const out = ts.transpileModule(readFileSync(file, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText
const mod = new Module(file)
mod.paths = Module._nodeModulePaths(path.dirname(file))
mod._compile(out, file)
const {parseInventoryWorkbooks, parseInventorySheet} = mod.exports

const HEAD = ['TIPODOCTO', 'BODEGA', 'Numero', 'Fecha', 'CodLegal', 'RazonSocial', 'Producto', 'GLOSA', 'Cantidad', 'UNIDAD', 'DocRel', 'NumRel',
  'FechaEntrega', 'Contrato', 'RefTipoDocto', 'RefCorrelativo', 'RefNumero', 'RefFecha', 'Lote', 'Color', 'Comentario', 'PesoUnitario',
  'PesoTotalxProducir', 'PesoTotalProduccido', 'CCostoJRM']

function book(sheets) {
  const wb = XLSX.utils.book_new()
  for (const [name, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa, {cellDates: true}), name)
  return XLSX.write(wb, {type: 'array', bookType: 'xlsx'})
}

test('Entradas y Salidas: cada fila va al lado de su signo, con fechas ISO, números y lotes como texto', () => {
  const rows = [HEAD,
    ['P/E PRODUCCION ACT.', '647-04  ALM PT', 139803, new Date(2026, 9, 8), null, null, 'E.CT.45', 'CORREA', 31, 'UND', 'ORDEN DE PRODUCCION', '2893-002',
      null, null, null, 0, 0, new Date(2020, 2, 22), 2893, null, 'IPT: 1', 73.2724, 0, 2271.4444, null],
    ['TRASPASO DE ALMACEN', '540-04 APT LB', 47727, new Date(2026, 9, 1), null, null, 'E.VOJH', 'VIGA', -78, 'UND', null, null,
      null, null, null, 0, 0, new Date(2020, 2, 22), 2870, null, null, 15.97, 0, 1245.66, null],
    [null, null, null, null, null, null, null, null, 9999, null],
  ]
  const res = parseInventoryWorkbooks([{name: 'Movs.xlsx', data: book({Hoja1: rows})}])
  const e = res.parts.find(p => p.side === 'E'), s = res.parts.find(p => p.side === 'S')
  assert.equal(e.rows.length, 1)
  assert.equal(s.rows.length, 1)
  assert.equal(e.rows[0].Fecha, '2026-10-08')
  assert.equal(e.rows[0].RefFecha, '2020-03-22')
  assert.equal(e.rows[0].Lote, '2893')
  assert.equal(e.rows[0].Numero, '139803')
  assert.equal(e.rows[0].Cantidad, 31)
  assert.equal(e.rows[0].PesoUnitario, 73.2724)
  assert.equal(e.rows[0].__row, 2)
  assert.equal(s.rows[0].Cantidad, -78)
  assert.equal(s.desde, '2026-10-01')
  assert.deepEqual(Array.from(e.bodegas), ['647-04 ALM PT'])
  assert.equal(Math.round(e.kg), 2271)
  assert.ok(!('Color' in e.rows[0]), 'las columnas que no usa la base no se envían')
})

test('foto de stock: columnas Almacén / Código / Saldo / Peso y aviso de lados incompletos', () => {
  const res = parseInventoryWorkbooks([{name: 'Stock.xlsx', data: book({Stock: [
    ['Reporte de stock al 30/09/2026'],
    ['Almacén', 'Código', 'Descripción', 'Lote', 'UM', 'Saldo', 'Peso KG'],
    ['ALM PERNERIA CHILCA', '801.15.2580', 'PERNO', 2870, 'UND', 1200, 36],
  ]})}])
  assert.equal(res.parts.length, 1)
  const p = res.parts[0]
  assert.equal(p.side, 'STOCK')
  assert.deepEqual({...p.rows[0]}, {__row: 3, BODEGA: 'ALM PERNERIA CHILCA', Producto: '801.15.2580', GLOSA: 'PERNO', Lote: '2870', UNIDAD: 'UND', Cantidad: 1200, Peso: 36})
})

test('solo Entradas avisa que faltan las Salidas; hoja sin columnas se ignora; sin datos falla', () => {
  const res = parseInventoryWorkbooks([{name: 'E.xlsx', data: book({ENTRADAS: [HEAD, ['N/INGRESO ALMACEN', 'ALM MRO CHILCA', 'T001-1', '2026-10-01', null, null, 'X', 'Y', 5, 'UND']], Resumen: [['Total', 1]]})}])
  assert.ok(res.warnings.some(w => /Solo se cargan Entradas/.test(w)))
  assert.equal(res.ignored.length, 1)
  assert.equal(res.parts[0].rows[0].Fecha, '2026-10-01')
  assert.throws(() => parseInventoryWorkbooks([{name: 'x.xlsx', data: book({A: [['hola']]})}]), /No se encontraron movimientos/)
  assert.ok('skip' in parseInventorySheet([['a', 'b']], 'f', 's'))
})

test('hojas que se contienen (ENTRADA TOTAL con todo, SALIDA TOTAL con una parte) no duplican filas', () => {
  const d1 = ['DESPACHO VENTAS', 'ST-VENTAS-IMD', 'T001-1', '2026-09-01', null, null, 'P1', 'G', -5, 'UND']
  const d2 = ['DESPACHO VENTAS', 'ST-VENTAS-IMD', 'T001-2', '2026-09-02', null, null, 'P2', 'G', -3, 'UND']
  const e1 = ['P/E PRODUCCION ACT.', '647-04 ALM PT', '9001', '2026-09-01', null, null, 'P1', 'G', 5, 'UND']
  // Línea repetida legítima del mismo documento: aparece dos veces en la hoja grande y debe quedar dos veces
  const res = parseInventoryWorkbooks([{name: 'DATA.xlsx', data: book({'SALIDA TOTAL': [HEAD, d1], 'ENTRADA TOTAL': [HEAD, d1, d2, d2, e1]})}])
  const s = res.parts.find(p => p.side === 'S'), e = res.parts.find(p => p.side === 'E')
  assert.equal(res.parts.filter(p => p.side === 'S').length, 1)
  assert.equal(s.rows.length, 3)
  assert.equal(e.rows.length, 1)
  assert.equal(s.sheetName, 'SALIDA TOTAL + ENTRADA TOTAL')
  assert.ok(res.warnings.some(w => /se omitieron 1 fila/.test(w)))
})

// Import transport regressions run alongside the existing parser check in PR CI.
require('./test-inventario-upload.cjs')
