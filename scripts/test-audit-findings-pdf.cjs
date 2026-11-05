// Reporte PDF de hallazgos por OT: el modelo (función pura) trae las rondas, las fotos ANTES/DESPUÉS y los responsables.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const ts = require('typescript')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const context = { exports: {}, require }
vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/audit-findings-pdf.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context)
const { buildAuditFindingsReport } = context.exports

const row = (id, number, severity, status, at) => ({ id, number, registered_at: at, contract_id: 'c1', ot_code: 'OT-100', client_name: 'Cliente SA', severity, status, categories: ['Embalaje'], responsible_name: 'Ana Ríos', auditor_name: 'Luis Paz' })
const ev = (id, phase, path, correction_id = null, voided_at = null) => ({ id, phase, file_path: path, correction_id, description: id, voided_at })
const corr = (id, round, result, comment) => ({ id, round, action_executed: `Acción ${round}`, executed_at: '2026-11-02T10:00:00Z', observations: null, submitted_at: '2026-11-02T11:00:00Z',
  validated_at: '2026-11-02T12:00:00Z', result, validation_comment: comment, no_photo_reason: null, corrected_by_name: 'Ana Ríos', validated_by_name: 'Luis Paz' })

test('OT con 2 hallazgos, uno rechazado y luego cerrado', () => {
  const rows = [row('f2', 'HAL-2026-00002', 'MENOR', 'ABIERTO', '2026-11-03T09:00:00Z'), row('f1', 'HAL-2026-00001', 'MAYOR', 'CERRADO', '2026-11-01T09:00:00Z')]
  const details = [
    { finding: { id: 'f1', number: 'HAL-2026-00001', registered_at: '2026-11-01T09:00:00Z', severity: 'MAYOR', status: 'CERRADO', description: 'Caja rota', material_code: 'M-1', material_description: 'Tornillos', quantity: 3, unit: 'CJ', responsible_area: 'Almacén', closed_at: '2026-11-03T12:00:00Z' },
      categories: [{ name: 'Embalaje' }],
      evidence: [ev('a1', 'ANTES', 'f1/ANTES/u/1.jpg'), ev('a2', 'ANTES', 'f1/ANTES/u/2.jpg', null, '2026-11-01T10:00:00Z'), ev('d1', 'DESPUES', 'f1/DESPUES/u/3.jpg', 'r1'), ev('d2', 'DESPUES', 'f1/DESPUES/u/4.jpg', 'r2')],
      corrections: [corr('r2', 2, 'CONFORME', 'Ok'), corr('r1', 1, 'RECHAZADO', 'Falta rotular')] },
    { finding: { id: 'f2', number: 'HAL-2026-00002', registered_at: '2026-11-03T09:00:00Z', severity: 'MENOR', status: 'ABIERTO', description: 'Etiqueta' }, categories: [], evidence: [], corrections: [] },
  ]
  const r = JSON.parse(JSON.stringify(buildAuditFindingsReport(rows, details, '2026-11-05T15:00:00Z')))
  assert.equal(r.otCode, 'OT-100'); assert.equal(r.clientName, 'Cliente SA'); assert.equal(r.findings.length, 2)
  const [f1, f2] = r.findings
  assert.equal(f1.number, 'HAL-2026-00001', 'ordena por fecha de registro')
  assert.equal(f1.severity, 'Mayor'); assert.deepEqual(f1.categories, ['Embalaje']); assert.equal(f1.material, 'M-1 · Tornillos · 3 CJ')
  assert.deepEqual(f1.rounds.map(x => [x.round, x.result, x.comment]), [[1, 'Rechazado', 'Falta rotular'], [2, 'Conforme', 'Ok']])
  assert.deepEqual(f1.before.map(p => p.path), ['f1/ANTES/u/1.jpg'], 'excluye la foto anulada')
  assert.deepEqual(f1.after.map(p => p.path), ['f1/DESPUES/u/3.jpg', 'f1/DESPUES/u/4.jpg'])
  assert.deepEqual(f1.rounds.map(x => x.photos.map(p => p.path)), [['f1/DESPUES/u/3.jpg'], ['f1/DESPUES/u/4.jpg']], 'fotos DESPUÉS por ronda')
  assert.equal(f1.responsible, 'Ana Ríos'); assert.equal(f1.auditor, 'Luis Paz'); assert.equal(f1.responsibleArea, 'Almacén')
  assert.deepEqual(f1.rounds.map(x => [x.correctedBy, x.validatedBy]), [['Ana Ríos', 'Luis Paz'], ['Ana Ríos', 'Luis Paz']])
  assert.equal(f1.result, 'Cerrado conforme'); assert.equal(f1.closedAt, '2026-11-03T12:00:00Z')
  assert.equal(f2.status, 'Abierto'); assert.equal(f2.rounds.length, 0); assert.deepEqual(f2.categories, ['Embalaje'])
})
