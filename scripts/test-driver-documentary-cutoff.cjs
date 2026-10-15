const { test } = require('node:test')
const assert = require('node:assert/strict')
const ts = require('typescript')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const React = require('react')
const { create, act } = require('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT = true
function fixture(documentaryOnly) {
  const queued = [], points = []; let gpsCalls = 0
  const context = { exports: {}, window: { setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {} },
    navigator: { onLine: true, geolocation: { getCurrentPosition(resolve) { gpsCalls++; resolve({ timestamp: Date.now(), coords: { accuracy: 5, latitude: -12, longitude: -77 } }) } } },
    localStorage: { setItem(key, value) { points.push({ key, value }) } }, crypto: require('node:crypto').webcrypto,
    FileReader: class { readAsDataURL() { this.result = 'data:image/jpeg;base64,AAAA'; this.onload() } },
    require(name) {
      if (name === '@/lib/supabase/client') return { createClient: () => ({ rpc: async () => ({ data: { state: 'PENDIENTE', submissions: [] }, error: null }) }) }
      if (name === '@/lib/delivery') return { conformityLabels: {}, arrivalSourceLabel: () => '', deliveryTime: () => '' }
      if (name === './EvidenceForm') return { EvidenceForm: props => React.createElement('form', props) }
      if (name === './RejectionForm') return { RejectionForm: () => null }
      if (name === '@/lib/route-point-sync') return { readActionQueue: () => [], readRouteQueue: () => [], routeQueueKey: 'gps', saveOfflineAction: (type, payload) => queued.push({ type, payload }), syncOfflineActions: async () => {}, syncRoutePoints: async () => {} }
      return require(name)
    } }
  vm.runInNewContext(ts.transpileModule(readFileSync('src/components/delivery/DriverDelivery.tsx','utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return { Component: context.exports.DriverDelivery, props: { dispatchId: 'route', requestId: 'request', driverId: 'driver', userId: 'user', documentaryOnly, onChanged: async () => {} }, queued, points, gpsCalls: () => gpsCalls }
}
test('late guide upload does not require GPS or offer arrival; live route still captures location', async () => {
  for (const documentaryOnly of [true, false]) {
    const f = fixture(documentaryOnly); let tree
    await act(async () => { tree = create(React.createElement(f.Component, f.props)); await new Promise(r => setTimeout(r, 10)) })
    await act(async () => { await new Promise(r => setTimeout(r, 15)) })
    // Ruta en curso: «Confirmar llegada» y «¿No se pudo entregar?»; la carga documentaria tardía no ofrece ninguno
    const buttons = tree.root.findAllByType('button')
    assert.equal(buttons.length, documentaryOnly ? 0 : 2)
    if (!documentaryOnly) assert.ok(buttons.some(b => JSON.stringify(b.props.children).includes('No se pudo entregar')))
    await act(async () => { await tree.root.findByType('form').props.onSubmit({ files: [{}], packingFiles: [], receiver: 'Cliente', guide: 'T001-6591', note: '', operation: 'op' }) })
    assert.equal(f.gpsCalls(), documentaryOnly ? 0 : 1)
    assert.equal(f.points.length, documentaryOnly ? 0 : 1)
    assert.equal(f.queued.length, 1)
    assert.equal(f.queued[0].payload.guide, 'T001-6591')
    await act(async () => tree.unmount())
  }
})
