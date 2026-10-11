const { test } = require('node:test')
const assert = require('node:assert/strict')
const ts = require('typescript')
const { readFileSync } = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const file = path.resolve(__dirname, '../src/components/ui/table-sort.ts')
const mod = new Module(file, module)
mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file)
const { compareCells, nextDirection, sortKey } = mod.exports
const sortAll = (values, direction) => [...values].sort((a, b) => compareCells(a, b, direction))

test('amounts, quantities and codes sort by value, not by text', () => {
  assert.deepEqual(sortAll(['S/ 1,250.00', 'S/ 98.50', 'S/ 12,000.10'], 'ascending'), ['S/ 98.50', 'S/ 1,250.00', 'S/ 12,000.10'])
  assert.deepEqual(sortAll(['10 kg', '9 kg', '100 kg'], 'descending'), ['100 kg', '10 kg', '9 kg'])
  assert.deepEqual(sortAll(['OT 16544', 'OT 9', 'OT 1200'], 'ascending'), ['OT 9', 'OT 1200', 'OT 16544'])
  assert.deepEqual(sortAll(['-5 %', '12 %', '3.5 %'], 'ascending'), ['-5 %', '3.5 %', '12 %'])
})
test('Lima dates and times sort chronologically', () => {
  assert.deepEqual(sortAll(['05/10/2026, 11:00 a. m.', '05/10/2026, 01:30 p. m.', '28/09/2026'], 'ascending'), ['28/09/2026', '05/10/2026, 11:00 a. m.', '05/10/2026, 01:30 p. m.'])
  assert.deepEqual(sortAll(['2026-10-11', '2026-01-02', '2025-12-31'], 'ascending'), ['2025-12-31', '2026-01-02', '2026-10-11'])
  assert.equal(sortKey('12/04/26').kind, 'number')
})
test('text sorts in Spanish ignoring case and accents; empty values stay last', () => {
  assert.deepEqual(sortAll(['Ñaña', 'ancón', 'Barranco', '—', ''], 'ascending'), ['ancón', 'Barranco', 'Ñaña', '—', ''])
  assert.deepEqual(sortAll(['Ñaña', 'ancón', '—', 'Barranco'], 'descending'), ['Ñaña', 'Barranco', 'ancón', '—'])
})
test('header clicks cycle ascending, descending and original order', () => {
  assert.equal(nextDirection(null), 'ascending')
  assert.equal(nextDirection('ascending'), 'descending')
  assert.equal(nextDirection('descending'), null)
})
