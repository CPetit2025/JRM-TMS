// Hoja de contenido del bulto agrupado y textos de la etiqueta: formato A5/A4, varias hojas e ítems por producto + lote.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), ts = require('typescript')
const cache = {}
function load(file) {
  if (cache[file]) return cache[file].exports
  const out = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  const m = { exports: {} }; cache[file] = m
  const req = id => id.startsWith('@/') ? load(['.ts', '.tsx'].map(e => path.join('src', id.slice(2)) + e).find(fs.existsSync)) : require(id)
  new Function('exports', 'require', 'module', out)(m.exports, req, m)
  return m.exports
}
global.fetch = async () => { throw new Error('sin red en la prueba') } // el logo es opcional: la hoja se genera sin él
const { buildBultoContentPdf, contentSheetFormat, itemLines, needsContentSheet, A5_ROWS } = load('src/lib/warehouse/packing-list.ts')
const { bultoNumber, identifierFontSize } = load('src/lib/warehouse/package-label.ts')
const pkgs = (n, skus = n) => Array.from({ length: n }, (_, i) => ({ package_code: `16573-B-${String(i + 1).padStart(4, '0')}`, product_code: `SKU-${i % skus}`, description: 'VIGA SUPERIOR PORTAMADERA VIPM 7 CM X 1.22M MEDIDA TERMINADO', lot: '16573', quantity: 10, unit: 'UND', weight_kg: 5 }))
const task = { client_name: 'RINTI S A', contract_code: '16573', request_number: 'RT-004035' }
;(async () => {
  assert.equal(itemLines(pkgs(6, 2)), 2, 'ítems = producto + lote distintos')
  assert.equal(needsContentSheet(pkgs(4)), false, 'hasta 4 ítems caben en la etiqueta')
  assert.equal(needsContentSheet(pkgs(5)), true, 'más de 4 ítems llevan hoja de contenido')
  assert.equal(contentSheetFormat(A5_ROWS), 'a5'); assert.equal(contentSheetFormat(A5_ROWS + 1), 'a4')
  const lpn = list => ({ lpn_code: '16573-B-0020', package_count: list.length, quantity: list.length * 10, weight_kg: list.length * 5, packages: list })
  const small = await buildBultoContentPdf(lpn(pkgs(12)), task)
  assert.equal(small.format, 'a5'); assert.equal(small.pdf.getNumberOfPages(), 1)
  assert.equal(Math.round(small.pdf.internal.pageSize.getWidth()), 148, 'A5 de 148 mm')
  const reception = await buildBultoContentPdf(lpn(pkgs(3).map(p => ({ ...p, document: 'IPT-9' }))), { ...task, request_number: null }, { reception: true })
  assert.equal(reception.format, 'a5'); assert.equal(reception.pdf.getNumberOfPages(), 1, 'hoja de contenido del LPN de recepción')
  const big = await buildBultoContentPdf(lpn(pkgs(120)), task)
  assert.equal(big.format, 'a4'); assert.ok(big.pdf.getNumberOfPages() >= 3, 'continúa en varias hojas A4')
  assert.equal(bultoNumber('16573-B-0005'), 'B-0005'); assert.equal(bultoNumber('PKG-261102-04B6A4E9'), null)
  assert.equal(identifierFontSize('E.RVLST.20.0705.1220', 'Lote: 16573'), 26.457, 'SKU y lote normales: tamaño completo')
  assert.ok(identifierFontSize('X'.repeat(30), 'Lote: ' + 'L'.repeat(20)) < 18, 'textos largos reducen la letra para no recortarse')
  console.log('PASS: hoja de contenido A5/A4 en varias hojas, ítems por producto + lote, número de bulto y letra de SKU/lote.')
})().catch(e => { console.error(e); process.exitCode = 1 })
