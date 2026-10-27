const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const React = require('react')
const { create, act } = require('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT = true
global.document = { addEventListener() {}, removeEventListener() {} }
const filename = path.resolve(__dirname, '../src/components/solicitudes/OtPicker.tsx')
const loaded = new Module(filename, module)
loaded.paths = module.paths
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText, filename)
const { OtPicker } = loaded.exports
const node = (id, extra = {}) => ({ id, code: id, type: 'CONTRATO', parent_contract_id: null, client_name: 'Cliente', destination_district: 'Lima', destination_address: null, allocated_pen: null, balance_pen: null, ...extra })
const search = async (view, value) => act(async () => view.root.findByType('input').props.onChange({ target: { value } }))
const buttons = view => view.root.findAllByType('button')

test('finds accented destination, child codes and exact root beyond the first 40 results', async () => {
  const nodes = Array.from({ length: 80 }, (_, i) => node(`OT${i}`))
  nodes.push(node('child', { code: 'SUB-99', type: 'SUBCONTRATO', parent_contract_id: 'OT79', destination_district: 'Cañete' }))
  nodes.push(node('warranty', { code: 'GAR-99', type: 'GARANTIA', parent_contract_id: 'OT79' }))
  const selections = []
  let view
  await act(async () => { view = create(React.createElement(OtPicker, { nodes, value: '', onSelect: (...args) => selections.push(args), onClear() {} })) })
  await act(async () => view.root.findByType('input').props.onFocus())
  assert.equal(buttons(view).length, 40)
  await search(view, 'OT7')
  assert.equal(buttons(view)[0].findAllByType('span')[0].children[0], 'OT7')
  await search(view, 'canete')
  assert.equal(buttons(view).length, 2)
  await search(view, 'SUB-99')
  await act(async () => view.root.findByType('input').props.onKeyDown({ key: 'Enter', preventDefault() {} }))
  assert.deepEqual(selections, [['OT79', 'child']])
  await search(view, 'GAR-99')
  assert.equal(buttons(view).length, 0)
  await act(async () => view.unmount())
})

test('typing reuses normalized catalog with 10,000 OTs', async () => {
  const nodes = Array.from({ length: 10000 }, (_, i) => node(`OT${i}`))
  let view
  await act(async () => { view = create(React.createElement(OtPicker, { nodes, value: '', onSelect() {}, onClear() {} })) })
  const original = String.prototype.normalize
  let normalizations = 0
  String.prototype.normalize = function (...args) { normalizations++; return original.apply(this, args) }
  try {
    await search(view, 'OT9999')
    assert.equal(buttons(view).length, 1)
    assert.ok(normalizations < 10, `Normalized ${normalizations} strings while typing`)
  } finally {
    String.prototype.normalize = original
    await act(async () => view.unmount())
  }
})

test('shows loading rather than an empty result while catalog is pending', async () => {
  let view
  await act(async () => { view = create(React.createElement(OtPicker, { nodes: [], value: '', loading: true, onSelect() {}, onClear() {} })) })
  await act(async () => view.root.findByType('input').props.onFocus())
  assert.equal(view.root.findByProps({ role: 'status' }).children.join(''), 'Cargando OT…')
  await act(async () => view.unmount())
})
