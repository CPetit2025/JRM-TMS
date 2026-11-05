const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const React = require('react')
const { create, act } = require('react-test-renderer')

global.IS_REACT_ACT_ENVIRONMENT = true
const compiled = ts.transpileModule(readFileSync('src/components/contratos/TransportBudgetEditor.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText

async function fixture(amount = 0) {
  const state = { calls: [], saved: [], closed: 0, success: [], response: { data: { success: true }, error: null } }
  const Modal = props => React.createElement('section', { 'aria-label': props.title }, props.children)
  const context = { exports: {}, Error, require: id => {
    if (id === '@/lib/supabase/client') return { createClient: () => ({ rpc: async (name, args) => {
      state.calls.push({ name, args: JSON.parse(JSON.stringify(args)) })
      return state.response
    } }) }
    if (id === '@/components/ui/modal') return { Modal }
    if (id === 'sonner') return { toast: { success: message => state.success.push(message) } }
    return require(id)
  } }
  vm.runInNewContext(compiled, context)
  let view
  await act(async () => { view = create(React.createElement(context.exports.TransportBudgetEditor, {
    target: { id: 'error-child-id', code: '16544-E012', allocated_pen: amount },
    onClose: () => state.closed++, onSaved: value => state.saved.push(value),
  })) })
  return {
    state, view,
    amount: value => act(async () => view.root.findByType('input').props.onChange({ target: { value } })),
    reason: value => act(async () => view.root.findByType('textarea').props.onChange({ target: { value } })),
    submit: () => act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {} })),
    close: () => act(async () => view.root.findByType(Modal).props.onClose()),
    dispose: () => act(async () => view.unmount()),
  }
}

test('edita el error seleccionado mediante la RPC existente y confirma el refresco solo al guardar', async () => {
  const f = await fixture('2764.10')
  assert.equal(f.view.root.findByType('input').props.value, '2764.10')
  assert.equal(f.state.calls.length, 0, 'Abrir el editor no modifica importes')
  await f.amount('3125.50'); await f.reason('Corrección de partida'); await f.submit()
  assert.deepEqual(f.state.calls, [{ name: 'set_contract_transport_budget', args: {
    p_contract_id: 'error-child-id', p_amount: 3125.5, p_reason: 'Corrección de partida',
  } }])
  assert.deepEqual(f.state.saved, [3125.5])
  assert.equal(f.state.success.length, 1)
  await f.dispose()
})

test('permite cero explícito, pero rechaza vacíos, negativos, importes no finitos y más de dos decimales', async () => {
  const f = await fixture(100)
  for (const invalid of ['', ' ', '-1', 'NaN', 'Infinity', '1.001', '1000000000000']) {
    await f.amount(invalid); await f.submit()
    assert.equal(f.state.calls.length, 0, `No debe guardar ${JSON.stringify(invalid)}`)
    assert.ok(f.view.root.findByProps({ role: 'alert' }))
  }
  await f.amount('0.00'); await f.submit()
  assert.equal(f.state.calls[0].args.p_amount, 0)
  assert.ok(f.state.calls[0].args.p_reason.includes('16544-E012'))
  assert.deepEqual(f.state.saved, [0])
  await f.dispose()
})

test('un rechazo del servidor conserva el editor y el monto; no informa éxito y permite reintentar', async () => {
  for (const response of [
    { data: null, error: { message: 'Sin permiso para modificar la partida' } },
    { data: { success: false, error: 'No se puede reducir por debajo de lo ya reservado' }, error: null },
    { data: null, error: null },
  ]) {
    const f = await fixture(500)
    f.state.response = response
    await f.amount('250.00'); await f.submit()
    assert.deepEqual(f.state.saved, [])
    assert.deepEqual(f.state.success, [])
    assert.equal(f.view.root.findByType('input').props.value, '250.00')
    assert.ok(f.view.root.findByProps({ role: 'alert' }))
    f.state.response = { data: { success: true }, error: null }
    await f.submit()
    assert.deepEqual(f.state.saved, [250])
    await f.dispose()
  }
})

test('cancelar no escribe y durante el guardado se bloquean cierre y envíos duplicados', async () => {
  const f = await fixture(100)
  await f.close()
  assert.equal(f.state.closed, 1)
  assert.equal(f.state.calls.length, 0)
  let resolve
  f.state.response = new Promise(done => { resolve = done })
  const form = f.view.root.findByType('form')
  let pending
  await act(async () => { pending = form.props.onSubmit({ preventDefault() {} }) })
  assert.equal(f.view.root.findByType('input').props.disabled, true)
  await f.close(); await f.submit()
  assert.equal(f.state.closed, 1)
  assert.equal(f.state.calls.length, 1)
  await act(async () => { resolve({ data: { success: true }, error: null }); await pending })
  assert.deepEqual(f.state.saved, [100])
  await f.dispose()
})
