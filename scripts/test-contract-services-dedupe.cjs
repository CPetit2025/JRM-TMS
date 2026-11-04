const assert = require('node:assert/strict')
const { excludeIncompleteServiceDuplicates } = require('../src/lib/contract-services-dedupe.js')

const complete = {
  id: 'complete', contract_id: 'ot-1', service_type: 'FLETE', service_date: '2026-10-30', amount_pen: 250,
  status: 'REGISTRADO', description: 'Carga materiales', dispatch_id: 'dispatch-1', plate: 'ABC123',
  driver_name: 'Conductor Uno', referral_guide: 'T001-123', provider_name: 'Transportes Uno', provider_ruc: '20123456789',
  category: 'Contrato', created_at: '2026-10-30T10:00:00Z',
}
const incomplete = { ...complete, id: 'incomplete', dispatch_id: null, plate: null, driver_name: null, referral_guide: null, provider_name: null, provider_ruc: null, category: null }

let result = excludeIncompleteServiceDuplicates([incomplete, complete])
assert.deepEqual(result.services.map(row => row.id), ['complete'])
assert.equal(result.suppressedCount, 1)

result = excludeIncompleteServiceDuplicates([complete, { ...incomplete, id: 'different-route', dispatch_id: 'dispatch-2' }])
assert.equal(result.services.length, 2, 'never combines different linked dispatches')

result = excludeIncompleteServiceDuplicates([complete, { ...complete, id: 'cancelled-copy', status: 'ANULADO' }])
assert.equal(result.services.length, 2, 'keeps annulled audit rows visible')

result = excludeIncompleteServiceDuplicates([complete, { ...complete, id: 'same-completeness' }])
assert.equal(result.services.length, 2, 'does not hide equally complete records')

result = excludeIncompleteServiceDuplicates([
  { ...incomplete, id: 'manual-a', dispatch_id: null, description: 'Servicio X', created_at: '2026-10-30T10:00:00Z' },
  { ...complete, id: 'manual-b', dispatch_id: null, description: 'Servicio X', created_at: '2026-10-30T10:05:00Z' },
])
assert.equal(result.suppressedCount, 1, 'uses matching description and close creation time for manual copies')

result = excludeIncompleteServiceDuplicates([
  { ...incomplete, id: 'old-a', dispatch_id: null, description: 'Servicio X', created_at: '2026-10-30T10:00:00Z' },
  { ...complete, id: 'old-b', dispatch_id: null, description: 'Servicio X', created_at: '2026-10-30T12:00:00Z' },
])
assert.equal(result.services.length, 2, 'does not guess from matching amount and date alone')

console.log('OK: incompletos duplicados ocultos con evidencia; cargos distintos e historial preservados')
