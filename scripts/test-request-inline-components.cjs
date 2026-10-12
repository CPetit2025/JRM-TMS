const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const React = require('react')
const { create, act } = require('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT = true
const filename = path.resolve(__dirname, '../src/components/solicitudes/InlineComponentCreator.tsx')
const loaded = new Module(filename, module)
loaded.paths = module.paths
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
}).outputText, filename)
const { InlineComponentCreator } = loaded.exports
const button = (renderer, name) => renderer.root.findAllByType('button').find(node => node.children.filter(value => typeof value === 'string').join('') === name)
const mount = async props => { let renderer; await act(async () => { renderer = create(React.createElement(InlineComponentCreator, { rootId: 'mother', rootCode: '16528', ...props })) }); return renderer }

test('inline creation normalizes suffix and includes chosen variant without a budget or nested form', async () => {
  const calls = []
  const renderer = await mount({ create: async (...args) => { calls.push(args) } })
  await act(async () => button(renderer, 'Registrar subcontrato').props.onClick())
  assert.equal(button(renderer, 'Registrar e incluir').props.disabled, true)
  await act(async () => renderer.root.findByType('input').props.onChange({ target: { value: ' s001 ' } }))
  assert.equal(renderer.root.findByType('input').props.value, 'S001')
  await act(async () => button(renderer, 'Registrar e incluir').props.onClick())
  assert.deepEqual(calls, [['SUBCONTRATO', 'S001']])
  assert.equal(renderer.root.findAllByType('input').length, 0)
  assert.equal(renderer.root.findAllByType('form').length, 0)
  await act(async () => renderer.unmount())
})

test('save disables duplicate clicks, retains error inline and allows retry without losing the entered code', async () => {
  let reject, calls = 0
  const waiting = new Promise((_, fail) => { reject = fail })
  const renderer = await mount({ create: async () => { calls++; return waiting } })
  await act(async () => button(renderer, 'Registrar error').props.onClick())
  await act(async () => renderer.root.findByType('input').props.onChange({ target: { value: 'E014' } }))
  await act(async () => button(renderer, 'Registrar e incluir').props.onClick())
  assert.equal(button(renderer, 'Registrando…').props.disabled, true)
  assert.equal(renderer.root.findByType('input').props.disabled, true)
  await act(async () => { reject(new Error('Este código ya está registrado.')) })
  assert.equal(calls, 1)
  assert.equal(renderer.root.findByProps({ role: 'alert' }).children.join(''), 'Este código ya está registrado.')
  assert.equal(renderer.root.findByType('input').props.value, 'E014')
  assert.equal(button(renderer, 'Registrar e incluir').props.disabled, false)
  await act(async () => renderer.unmount())
})

test('a different mother key resets the inline draft instead of carrying a suffix to another OT', async () => {
  const createVariant = async () => {}
  let renderer
  await act(async () => { renderer = create(React.createElement(InlineComponentCreator, { key: 'A', rootId: 'A', rootCode: '16528', create: createVariant })) })
  await act(async () => button(renderer, 'Registrar error').props.onClick())
  await act(async () => renderer.root.findByType('input').props.onChange({ target: { value: 'E014' } }))
  await act(async () => renderer.update(React.createElement(InlineComponentCreator, { key: 'B', rootId: 'B', rootCode: '16529', create: createVariant })))
  assert.equal(renderer.root.findAllByType('input').length, 0)
  await act(async () => renderer.unmount())
})
