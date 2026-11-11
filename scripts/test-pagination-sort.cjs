const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const Module = require('node:module')
function load(relative) {
  const file = path.resolve(__dirname, '..', relative)
  const mod = new Module(file, module)
  mod.paths = module.paths
  const native = mod.require.bind(mod)
  mod.require = name => name.startsWith('.') ? load(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(file), `${name}.ts`))) : native(name)
  mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, file)
  return mod.exports
}
const { sortRows } = load('src/lib/use-pagination.ts')
const rows = [{ n: 'b', m: 10, d: '2026-01-02' }, { n: 'a', m: 9, d: null }, { n: 'c', m: 100, d: '2025-12-31' }]
const value = (r, c) => [r.n, r.m, r.d][c]
const names = list => list.map(r => r.n).join('')

test('sorts the full array with DataTable semantics', () => {
  assert.equal(names(sortRows(rows, { column: 0, direction: 'ascending' }, value)), 'abc')
  assert.equal(names(sortRows(rows, { column: 1, direction: 'descending' }, value)), 'cba') // numeric, not text
  assert.equal(names(sortRows(rows, { column: 2, direction: 'ascending' }, value)), 'cba') // dates; empty last
  assert.equal(names(sortRows(rows, { column: 2, direction: 'descending' }, value)), 'bca') // empty still last
})
test('null sort or no sortValue keeps the original order', () => {
  assert.equal(sortRows(rows, null, value), rows)
  assert.equal(sortRows(rows, { column: 0, direction: 'ascending' }), rows)
})
test('celdas con JSX ordenan por su texto', () => {
  const React = require('react')
  const { cellValue } = load('src/lib/use-pagination.ts')
  assert.equal(cellValue(React.createElement('span', null, 'Activo', ' ', 3)), 'Activo 3')
})
