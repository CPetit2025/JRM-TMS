import assert from 'node:assert/strict'
import { requiresOrderReference, orderReferenceComplete } from '../src/lib/request-reference.ts'

for (const service of ['RECOJO', 'TRASLADO']) assert.equal(requiresOrderReference(service), true)
assert.equal(requiresOrderReference('DESPACHO'), false)
for (const type of ['OC', 'OS', 'RQ']) {
  assert.equal(orderReferenceComplete(type, ' 12345 '), true)
  assert.equal(orderReferenceComplete(type, '  '), false)
  assert.equal(orderReferenceComplete(type, null), false)
}
assert.equal(orderReferenceComplete('oc', '12345'), true)
assert.equal(orderReferenceComplete('OT', '16528'), false)
assert.equal(orderReferenceComplete('', '12345'), false)
assert.equal(orderReferenceComplete('OC', '1'.repeat(101)), false)
console.log('PASS: recojo y traslado requieren OC/OS/RQ numerada; entrega conserva OT y referencias incompletas se rechazan.')
