const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const React = require('react')
const { create, act } = require('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT = true
const key = token => `jrm:tracking-access:v2:${token}`
// La sesión guarda el código y a la persona identificada (nombre) que ve el portal
const access = (pin, viewer = 'viewer-1', name = 'Ana Pérez') => JSON.stringify({ pin, viewer, name })
const payload = { mode: 'permanent', label: 'Gerencia', rows: [], requests: [] }
function harness(initial = {}) {
  const store = new Map(Object.entries(initial)), calls = []
  let token = 'link-A', answer = { data: payload }, interval
  const client = { rpc: async (name, args) => {
    calls.push({ name, ...args }); const value = await answer
    if (value instanceof Error) throw value
    // Ingreso con nombre: si el portal respondería datos, la persona queda registrada
    if (name === 'tracking_portal_sign_in' && value?.data?.mode) return { data: { success: true, viewer_id: 'viewer-1', name: args.p_name }, error: null }
    return value
  } }
  const browser = { sessionStorage: { getItem: k => store.get(k) || null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) }, setInterval: fn => { interval = fn; return 1 }, clearInterval: () => { interval = null } }
  const mocks = name => {
    if (name === 'next/navigation') return { useParams: () => ({ token }) }
    if (name === '@/lib/supabase/client') return { createClient: () => client }
    if (name === 'sonner') return { toast: { success() {}, error() {} } }
    if (name === '@/lib/tracking-calendar') return { limaDay: () => '2026-10-12', monthDays: () => ['2026-10-01', ...Array(40).fill('2026-10-12'), '2026-11-11'] }
    if (name.startsWith('@/components/')) return new Proxy({}, { get: (_, component) => props => React.createElement('section', { 'data-component': component, ...props }) })
    return require(name)
  }
  const context = { exports: {}, require: mocks, window: browser }
  vm.runInNewContext(ts.transpileModule(readFileSync('src/app/tracking/[token]/page.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, context)
  let tree
  const render = async () => { await act(async () => { tree = create(React.createElement(context.exports.default)) }); return tree }
  return { store, calls, render, get tree() { return tree }, respond: value => { answer = value }, tick: async () => { await act(async () => { await interval?.() }) }, token: async value => { token = value; await act(async () => tree.update(React.createElement(context.exports.default))) }, unmount: async () => { await act(async () => tree.unmount()) } }
}
function text(node) { return typeof node === 'string' ? node : (node?.children || []).map(text).join('') }
function signedIn(tree) { return tree.root.findAllByType('button').some(b => text(b) === 'Salir') }
const pinInput = tree => tree.root.findAllByType('input').at(-1)
async function signIn(h, pin, name = 'Ana Pérez') {
  await act(async () => h.tree.root.findAllByType('input')[0].props.onChange({ target: { value: name } }))
  await act(async () => pinInput(h.tree).props.onChange({ target: { value: pin } }))
  await act(async () => h.tree.root.findByType('form').props.onSubmit({ preventDefault() {} }))
}
test('refresh restores tab-scoped access only after server validation; explicit exit clears it', async () => {
  const h = harness(); await h.render(); await signIn(h, 'A7K2')
  assert.equal(h.store.get(key('link-A')), access('A7K2')); assert.ok(signedIn(h.tree))
  assert.equal(h.calls.find(c => c.name === 'tracking_portal_sign_in').p_name, 'Ana Pérez')
  await h.unmount(); const before = h.calls.length; await h.render()
  assert.ok(h.calls.length > before); assert.equal(h.calls[before].p_pin, 'A7K2'); assert.equal(h.calls[before].p_viewer, 'viewer-1'); assert.ok(signedIn(h.tree))
  await act(async () => h.tree.root.findAllByType('button').find(b => text(b) === 'Salir').props.onClick())
  assert.equal(h.store.has(key('link-A')), false); assert.equal(signedIn(h.tree), false)
  await h.unmount()
})
for (const error of ['Acceso revocado', 'Código de acceso incorrecto', 'Tracking link is invalid, expired, or incorrect PIN.']) test(`server rejects restored access: ${error}`, async () => {
  const h = harness({ [key('link-A')]: access('A7K2') }); h.respond({ data: { error } }); await h.render()
  assert.equal(signedIn(h.tree), false); assert.equal(h.store.has(key('link-A')), false)
  assert.equal(pinInput(h.tree).props.value, ''); await h.unmount()
})
test('network failure during restoration retains credential and retry validates it again', async () => {
  const h = harness({ [key('link-A')]: access('A7K2') }); h.respond(new Error('Network unavailable')); await h.render()
  assert.equal(signedIn(h.tree), false); assert.equal(h.store.get(key('link-A')), access('A7K2'))
  assert.ok(h.tree.root.findAllByType('button').some(b => text(b) === 'Reintentar acceso'))
  h.respond({ data: payload }); await act(async () => h.tree.root.findByType('form').props.onSubmit({ preventDefault() {} }))
  assert.ok(signedIn(h.tree)); await h.unmount()
})
test('transient polling error preserves session, while revocation removes data and credential', async () => {
  const h = harness({ [key('link-A')]: access('12345678') }); await h.render()
  h.respond({ error: { message: 'canceling statement due to statement timeout' } }); await h.tick()
  assert.ok(signedIn(h.tree)); assert.equal(h.store.get(key('link-A')), access('12345678'))
  h.respond({ data: { error: 'Acceso revocado' } }); await h.tick()
  assert.equal(signedIn(h.tree), false); assert.equal(h.store.has(key('link-A')), false); await h.unmount()
})
test('changing link never reuses another token credential, and failed codes are never saved', async () => {
  const h = harness({ [key('link-A')]: access('A7K2') }); await h.render(); const before = h.calls.length
  await h.token('link-B'); assert.equal(signedIn(h.tree), false); assert.equal(h.calls.length, before)
  h.respond({ data: { error: 'Código de acceso incorrecto' } }); await signIn(h, 'ZZZZ')
  assert.equal(h.store.has(key('link-B')), false); assert.equal(h.store.get(key('link-A')), access('A7K2')); await h.unmount()
})
test('rate limiting retains saved credential and does not poll before validation', async () => {
  const h = harness({ [key('link-A')]: access('A7K2') }); h.respond({ data: { error: 'Demasiados intentos. Inténtalo en 15 minutos.' } }); await h.render()
  const before = h.calls.length; await h.tick()
  assert.equal(h.calls.length, before); assert.equal(signedIn(h.tree), false); assert.equal(h.store.get(key('link-A')), access('A7K2')); await h.unmount()
})
test('a delayed restore never displays data before verification and cannot authorize a different link', async () => {
  let resolve
  const h = harness({ [key('link-A')]: access('A7K2') }); h.respond(new Promise(r => { resolve = r })); await h.render()
  assert.equal(signedIn(h.tree), false); assert.match(text(h.tree.toJSON()), /Verificando tu acceso/)
  await h.token('link-B'); await act(async () => resolve({ data: payload }))
  assert.equal(signedIn(h.tree), false); assert.equal(h.store.has(key('link-B')), false); await h.unmount()
})
test('a malformed server response cannot restore authentication', async () => {
  const h = harness({ [key('link-A')]: access('A7K2') }); h.respond({ data: null, error: null }); await h.render()
  assert.equal(signedIn(h.tree), false); assert.equal(h.store.get(key('link-A')), access('A7K2')); await h.unmount()
})
test('the portal asks for the person name before the access code and an old session without name is not restored', async () => {
  const h = harness({ ['jrm:tracking-access:link-A']: 'A7K2' }); await h.render()
  assert.equal(signedIn(h.tree), false); assert.equal(h.calls.length, 0)
  const inputs = h.tree.root.findAllByType('input'); assert.equal(inputs.length, 2); assert.equal(inputs[0].props.autoComplete, 'name')
  await signIn(h, 'A7K2', 'X'); assert.equal(h.calls.length, 0, 'sin nombre válido no consulta el servidor')
  await h.unmount()
})
