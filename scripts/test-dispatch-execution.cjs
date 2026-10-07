const { test } = require('node:test')
const assert = require('node:assert/strict')
const ts = require('typescript')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const React = require('react')
const { create, act } = require('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT = true
function load(file, mock) {
  const context = { exports: {}, require: mock }
  vm.runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText, context)
  return context.exports
}
const rules = load('src/lib/dispatch-execution.ts', require)
function fixture({ status = 'PROGRAMADO', modalidad, writable = true, response = { data: { success: true }, error: null } } = {}) {
  const calls = [], success = [], errors = []
  let changes = 0
  const { DispatchExecutionActions } = load('src/components/transport/DispatchExecutionActions.tsx', name => {
    if (name === '@/hooks/usePermissions') return { usePermissions: () => ({ canWrite: () => writable }) }
    if (name === '@/lib/supabase/client') return { createClient: () => ({ rpc: async (rpc, args) => { calls.push({ rpc, args }); return response } }) }
    if (name === '@/lib/caja') return { errorMessage: error => error.message }
    if (name === '@/lib/dispatch-execution') return rules
    if (name === 'sonner') return { toast: { success: message => success.push(message), error: message => errors.push(message) } }
    if (name === 'lucide-react') return { CheckCircle2: () => null, Loader2: () => null, PlayCircle: () => null }
    return require(name)
  })
  return { Component: DispatchExecutionActions, props: { dispatch: { id: 'route', status, modalidad }, onChanged: () => { changes++ } }, calls, success, errors, changed: () => changes }
}
async function click(f) {
  let tree
  await act(async () => { tree = create(React.createElement(f.Component, f.props)) })
  await act(async () => { tree.root.findByType('button').props.onClick() })
  await act(async () => { tree.unmount() })
}
test('preparation calls authoritative server without requesting destination signed guide', async () => {
  const f = fixture()
  await click(f)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].rpc, 'transition_dispatch_status')
  assert.equal(f.calls[0].args.p_new_status, 'EN_CURSO')
  assert.equal(f.changed(), 1)
  assert.match(f.success[0], /GPS comenzará cuando el conductor/)
})
test('read-only roles and programmed external carrier cannot invoke internal preparation', async () => {
  for (const options of [{ writable: false, status: 'ENTREGADO' }, { modalidad: 'TERCERO' }]) {
    const f = fixture(options)
    let tree
    await act(async () => { tree = create(React.createElement(f.Component, f.props)) })
    assert.equal(tree.toJSON(), null)
    assert.equal(f.calls.length, 0)
    await act(async () => { tree.unmount() })
  }
})
test('server document rejection is displayed and does not advance operation', async () => {
  const f = fixture({ response: { data: { success: false, error: 'Packing List pendiente' }, error: null } })
  await click(f)
  assert.equal(f.changed(), 0)
  assert.equal(f.success.length, 0)
  assert.equal(f.errors[0], 'Packing List pendiente')
})
test('closing with null or zero GPS never fabricates a measured zero distance', async () => {
  for (const km of [null, 0, undefined]) {
    const f = fixture({ status: 'ENTREGADO', response: { data: { success: true, actual_distance_km: km }, error: null } })
    await click(f)
    assert.equal(f.calls[0].rpc, 'close_dispatch_route')
    assert.match(f.success[0], /sin medición GPS/)
    assert.doesNotMatch(f.success[0], /0\.000 km/)
  }
  assert.match(rules.dispatchClosureMessage({ actual_distance_km: '12.345', gps_complete: false }), /12\.345 km GPS.*cobertura parcial/)
})
test('return authorization only emits return transition', async () => {
  const f = fixture({ status: 'ESPERANDO_AUTORIZACION' })
  await click(f)
  assert.equal(f.calls[0].rpc, 'transition_dispatch_status')
  assert.equal(f.calls[0].args.p_new_status, 'RETORNO')
})
test('customer pickup preparation and closure never announce GPS operation or reconciliation', async () => {
  const f = fixture({ modalidad: 'RECOJO_CLIENTE' })
  await click(f)
  assert.match(f.success[0], /Retiro preparado/)
  assert.doesNotMatch(f.success[0], /GPS comenzará/)
  assert.doesNotMatch(rules.dispatchClosureMessage({ actual_distance_km: 0 }, 'RECOJO_CLIENTE'), /pendiente de conciliación/)
})
