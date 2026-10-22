const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const mod = { exports: {} }
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/apt/operations.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: mod.exports, URLSearchParams })
const { operationalDecision, operationalOt, operationalTraceHref, operationalReadinessState } = mod.exports
const row = { almacen: 'ST', lote: '16339-E014', cliente: 'JRM', stock_tn: 12, inferred_opening_tn: 0, age_days: 80, stock_tn_days: 960 }
assert.equal(operationalDecision(row, false, 60).review, 'ACTUALIZACION', 'stale model must precede age urgency')
assert.equal(operationalDecision({ ...row, inferred_opening_tn: 2 }, true, 60).review, 'ORIGEN', 'inferred opening must be reconciled before age prioritization')
assert.equal(operationalDecision({ ...row, inferred_opening_tn: null }, true, 60).review, 'ORIGEN', 'missing historical composition is not zero')
assert.equal(operationalDecision({ ...row, age_days: null }, true, 60).review, 'ORIGEN', 'unknown age is not new inventory')
assert.equal(operationalDecision(row, true, 60).review, 'PERMANENCIA')
assert.equal(operationalDecision({ ...row, age_days: 60 }, true, 60).review, 'TRAZABILIDAD', 'threshold is strict, consistent with configured alerts')
assert.equal(operationalDecision(row, true, null).review, 'TRAZABILIDAD', 'no arbitrary age threshold')
for (const sample of [row, { ...row, age_days: null }, { ...row, stock_tn: 0 }]) {
 const decision = operationalDecision(sample, true, 60)
 assert.equal(decision.availability, 'NO_REGISTRADA', 'inventory balance must never authorize dispatch')
 assert.equal(decision.responsible, null, 'do not infer an operational owner')
}
assert.equal(operationalOt('16339-E014'), '16339')
assert.equal(operationalOt('16339-S001'), '16339')
assert.equal(operationalOt('ADELANTO-123'), null)
const href = operationalTraceHref('16339-E014', '2026-10-01')
assert.equal(JSON.parse(new URL('https://jrm.example' + href).searchParams.get('g')).corte, '2026-10-01', 'historical drilldown must preserve selected cutoff')
assert.equal(new URL('https://jrm.example' + operationalTraceHref('LOT & 3', null)).searchParams.get('q'), 'LOT & 3')
const record = { almacen: 'ST', lote: '16339', producto: '*', status: 'DISPONIBLE', reason: 'Revisado', responsible_name: 'APT', next_action: 'Coordinar', updated_at: '2026-10-10T13:00:00Z', updated_by: null }
assert.equal(operationalReadinessState(record, '2026-10-10T14:00:00Z').status, 'NO_EVALUADO', 'new material must invalidate an older available review')
assert.equal(operationalReadinessState(record, '2026-10-10T12:00:00Z').status, 'DISPONIBLE')
assert.equal(operationalReadinessState(record, null).status, 'NO_EVALUADO', 'without a known model version availability cannot be certified current')
assert.equal(operationalReadinessState({ ...record, updated_at: 'bad' }, '2026-10-10T12:00:00Z').needsReview, true)
assert.equal(operationalReadinessState(undefined, '2026-10-10T12:00:00Z').status, 'NO_EVALUADO')
console.log('APT operations: evidence precedence, unknown values, no dispatch authorization, and historical drilldown passed.')
