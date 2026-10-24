// Exportación completa del análisis ERP (src/lib/erp/exportar.ts): pide todas las páginas con orden estable y comprueba que
// las filas exportadas coinciden con el total filtrado. Servidor simulado con el mismo tope de 20.000 filas por consulta.
const {test} = require('node:test')
const assert = require('node:assert/strict')
const {readFileSync} = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

const file = path.join(__dirname, '../src/lib/erp/exportar.ts')
const out = ts.transpileModule(readFileSync(file, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText
const mod = new Module(file)
mod.paths = Module._nodeModulePaths(path.dirname(file))
mod._compile(out, file)
const {fetchAllRows} = mod.exports

const CAP = 20000
const rowsOf = n => Array.from({length: n}, (_, i) => ({documento: `D${i}`, cod_producto: 'P', unidad: 'UND'}))
// Igual que erp_analisis: limit acotado a 20.000, offset y total del filtro
const server = (rows, hooks = {}) => async (offset, limit) => {
  const l = Math.min(Math.max(limit, 1), CAP)
  hooks.calls = (hooks.calls || 0) + 1
  return {total: hooks.total ?? rows.length, filas: (hooks.page ?? (o => rows.slice(o, o + l)))(offset, l)}
}
const key = r => `${r.documento}|${r.cod_producto}|${r.unidad}`

test('exporta más de 20.000 filas completas y sin repetidos', async () => {
  const rows = rowsOf(20503)
  const hooks = {}
  const progress = []
  const res = await fetchAllRows(server(rows, hooks), {pageSize: 5000, keyOf: key, onProgress: (n, t) => progress.push([n, t])})
  assert.equal(res.total, 20503)
  assert.equal(res.rows.length, 20503)
  assert.equal(new Set(res.rows.map(key)).size, 20503)
  assert.deepEqual(res.rows.at(-1), rows.at(-1))
  assert.equal(hooks.calls, 5)
  assert.deepEqual(progress.at(-1), [20503, 20503])
})

test('una sola consulta del tope antiguo (20.000) quedaba corta', async () => {
  const page = await server(rowsOf(20503))(0, 50000)
  assert.equal(page.filas.length, CAP)
  assert.ok(page.total > page.filas.length)
})

test('página pedida mayor que el tope del servidor: se detecta el faltante', async () => {
  await assert.rejects(fetchAllRows(server(rowsOf(45000)), {pageSize: 25000, keyOf: key}), /Exportación incompleta: 40000 de 45000/)
})

test('si el total cambia entre páginas, no genera el archivo', async () => {
  const rows = rowsOf(12000)
  let n = 0
  const changing = async (o, l) => ({total: n++ === 0 ? 12000 : 12001, filas: rows.slice(o, o + l)})
  await assert.rejects(fetchAllRows(changing, {pageSize: 5000}), /Los datos cambiaron durante la exportación/)
})

test('filas repetidas entre páginas (orden inestable) se rechazan', async () => {
  const rows = rowsOf(10000)
  const unstable = server(rows, {page: (o, l) => rows.slice(Math.max(0, o - 1), Math.max(0, o - 1) + l)})
  await assert.rejects(fetchAllRows(unstable, {pageSize: 5000, keyOf: key}), /repetidas/)
})

test('página vacía antes del total: exportación incompleta', async () => {
  const rows = rowsOf(9000)
  const short = server(rows, {total: 9500})
  await assert.rejects(fetchAllRows(short, {pageSize: 3000}), /Exportación incompleta: 9000 de 9500/)
})

test('filtro sin filas: exporta 0 de 0', async () => {
  const res = await fetchAllRows(server([]), {pageSize: 5000})
  assert.deepEqual(res, {rows: [], total: 0})
})
