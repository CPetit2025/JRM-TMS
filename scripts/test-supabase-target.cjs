// Pruebas de la guarda TMS / WMS (scripts/check-supabase-target.cjs).
const test = require('node:test')
const assert = require('node:assert/strict')
const { checkTarget, refFromUrl, TMS_REF, WMS_STAGING_REF } = require('./check-supabase-target.cjs')

const WMS_PROD = 'abcdefghijklmnopqrst'
const url = ref => `https://${ref}.supabase.co/`
const ok = args => assert.deepEqual(checkTarget(args), [])
const fails = args => assert.equal(checkTarget(args).length, 1)

test('lee la referencia de la URL de Supabase', () => {
  assert.equal(refFromUrl(url(TMS_REF)), TMS_REF)
  assert.equal(refFromUrl('http://127.0.0.1:54321'), null)
  assert.equal(refFromUrl(''), '')
})

test('TMS: producción exige su propia base y nunca una de WMS', () => {
  ok({ app: 'tms', url: url(TMS_REF), strict: true })
  ok({ app: 'tms', ref: TMS_REF, strict: true })
  fails({ app: 'tms', url: url(WMS_PROD), strict: true })
  fails({ app: 'tms', ref: WMS_STAGING_REF, strict: true })
  fails({ app: 'tms', url: url(WMS_STAGING_REF) })
  fails({ app: 'tms', strict: true })
})

test('TMS: compilación local o de PR sin variables sigue funcionando', () => {
  ok({ app: 'tms' })
  ok({ app: 'tms', url: 'http://127.0.0.1:54321' })
})

test('WMS nunca apunta a TMS y Staging/Producción no se cruzan', () => {
  ok({ app: 'wms-staging', url: url(WMS_STAGING_REF), strict: true })
  ok({ app: 'wms-production', ref: WMS_PROD, strict: true })
  fails({ app: 'wms-staging', url: url(TMS_REF), strict: true })
  fails({ app: 'wms-production', ref: TMS_REF, strict: true })
  fails({ app: 'wms-production', url: url(WMS_STAGING_REF), strict: true })
  fails({ app: 'wms-staging', ref: WMS_PROD, strict: true })
  fails({ app: 'wms-production', strict: true })
  fails({ app: 'wms-production', url: 'http://127.0.0.1:54321', strict: true })
})

test('rechaza un sistema desconocido', () => fails({ app: 'wms', ref: WMS_PROD }))
