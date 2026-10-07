const { test } = require('node:test')
const assert = require('node:assert/strict')
const ts = require('typescript')
const { readFileSync } = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const file = path.resolve(__dirname, '../src/lib/document-flow.ts')
const mod = new Module(file, module)
mod._compile(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, file)
const { documentPhaseMatches } = mod.exports
const route = { status: 'EN_CURSO', docs_reissue: false, is_pickup: false }
test('mixed routes show observed stop only, preserving validated sibling', () => {
  assert.equal(documentPhaseMatches('observados', route, { conformity: 'OBSERVADA' }), true)
  assert.equal(documentPhaseMatches('observados', route, { conformity: 'VALIDADA' }), false)
})
test('customer pickup and canceled route do not request destination guide conformity', () => {
  assert.equal(documentPhaseMatches('conformidad', { ...route, is_pickup: true }), false)
  assert.equal(documentPhaseMatches('conformidad', { ...route, status: 'CANCELADO' }), false)
  assert.equal(documentPhaseMatches('historial', { ...route, status: 'CANCELADO' }), true)
})
test('predeparture queue never mixes departed routes; reissue remains visible', () => {
  assert.equal(documentPhaseMatches('salida', route), false)
  assert.equal(documentPhaseMatches('salida', { ...route, status: 'PROGRAMADO' }), true)
  assert.equal(documentPhaseMatches('observados', { ...route, status: 'PROGRAMADO', docs_reissue: true }), true)
})
