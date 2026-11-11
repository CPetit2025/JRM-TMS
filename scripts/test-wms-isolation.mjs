import assert from 'node:assert/strict'
import { assertDeploymentIsolation, wmsRouteAllowed } from '../src/lib/deployment-isolation.mjs'

const prod = 'https://glecgvomkaqmkfkhtxhi.supabase.co'
const staging = 'https://rquujukgtturdlkuzgdc.supabase.co'
assert.doesNotThrow(() => assertDeploymentIsolation('wms', prod, 'production'))
assert.doesNotThrow(() => assertDeploymentIsolation('wms', staging, 'preview'))
for (const url of [undefined, staging, 'https://tms.supabase.co', prod + '.evil.test', 'http://glecgvomkaqmkfkhtxhi.supabase.co']) {
  assert.throws(() => assertDeploymentIsolation('wms', url, 'production'))
}
assert.doesNotThrow(() => assertDeploymentIsolation(undefined, 'https://existing-tms.supabase.co', 'production'))
assert.throws(() => assertDeploymentIsolation('warehouse', prod, 'production'))
for (const path of ['/api/users/create', '/api/contratos/anular-servicio', '/solicitudes', '/contratos']) {
  assert.equal(wmsRouteAllowed(path, 'POST'), false, path)
}
assert.equal(wmsRouteAllowed('/api/app-version', 'POST'), false)
assert.equal(wmsRouteAllowed('/api/app-version', 'GET'), true)
assert.equal(wmsRouteAllowed('/api/wms/sincronizar', 'POST'), true)
assert.equal(wmsRouteAllowed('/api/wms/sincronizar', 'GET'), false)
assert.equal(wmsRouteAllowed('/api/wms/erp-aplicar', 'POST'), true)
assert.equal(wmsRouteAllowed('/api/wms/erp-aplicar', 'GET'), false)
for (const path of ['/api/erp/aplicar', '/api/inventario/procesar', '/api/apt/procesar']) {
  assert.equal(wmsRouteAllowed(path, 'POST'), true, path)
  assert.equal(wmsRouteAllowed(path, 'GET'), false, path)
}
assert.equal(wmsRouteAllowed('/almacen/etiquetado', 'GET'), true)
assert.equal(wmsRouteAllowed('/almacen-malicioso', 'GET'), false)
console.log('PASS: WMS production rejects other databases and blocks TMS routes/API mutations; TMS mode is unchanged.')
for (const method of ['GET', 'POST']) assert.equal(wmsRouteAllowed('/api/admin/wms', method), true)
for (const method of ['PUT', 'DELETE', 'PATCH']) assert.equal(wmsRouteAllowed('/api/admin/wms', method), false)
for (const path of ['/api/admin/wms/extra', '/api/admin/users', '/api/admin/wms-evil']) assert.equal(wmsRouteAllowed(path, 'POST'), false)
