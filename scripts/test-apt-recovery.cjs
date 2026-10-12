const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const React = require('react')
const { create, act } = require('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT = true
const listeners = new Map()
global.window = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name) } }
function load(relative, mocks = {}) {
  const filename = path.resolve(__dirname, relative)
  const mod = new Module(filename, module); mod.paths = module.paths
  const fallback = mod.require.bind(mod)
  mod.require = name => name in mocks ? mocks[name] : fallback(name)
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename)
  return mod.exports
}
const recovery = load('../src/lib/apt/readRecovery.ts')
test('APT errors present a human explanation without SQL details and preserve actionable business validation', () => {
  const { renderToStaticMarkup } = require('react-dom/server')
  const { ErrorBlock } = load('../src/components/apt/ui.tsx', {
    '@/lib/apt/format': {}, '@/lib/apt/readRecovery': recovery,
  })
  const timeout = renderToStaticMarkup(React.createElement(ErrorBlock, { message: 'canceling statement due to statement timeout', onRetry: () => {} }))
  assert.match(timeout, /La consulta está tardando/)
  assert.match(timeout, /Actualizar consulta/)
  assert.doesNotMatch(timeout, /canceling statement|statement timeout/)
  const denied = renderToStaticMarkup(React.createElement(ErrorBlock, { message: 'permission denied for table apt_movements' }))
  assert.match(denied, /No tienes acceso/)
  assert.doesNotMatch(denied, /apt_movements|permission denied/)
  const validation = renderToStaticMarkup(React.createElement(ErrorBlock, { message: 'El período comienza antes de los datos disponibles' }))
  assert.match(validation, /El período comienza antes/)
})
let authCallback, user = 'user-A', synchronousInitialSession = false, getSessionOverride = null, cleared = 0, apiRead = async () => ({ value: 'initial' })
const client = { auth: { getSession: () => getSessionOverride || Promise.resolve({ data: { session: user ? { user: { id: user } } : null } }), onAuthStateChange: cb => { authCallback = cb; if (synchronousInitialSession) cb('INITIAL_SESSION', user ? { user: { id: user } } : null); return { data: { subscription: { unsubscribe: () => { authCallback = null } } } } } } }
const hooks = load('../src/lib/apt/useAptOperationalQuery.ts', {
  '@/lib/supabase/client': { createClient: () => client },
  './api': { clearAptCache: () => { cleared++ }, aptApi: { operationalSummary: (...args) => apiRead(...args) } },
  './readRecovery': recovery,
})
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let result
function Query(props) { result = hooks.useRecoverableAptRead(props.identity, props.read, 1); return null }
function Operational(props) { result = hooks.useAptOperationalQuery(props.filters || {}, props.queryKey || '{}', 25, props.page || 1); return null }
const mount = async element => { let renderer; await act(async () => { renderer = create(element) }); return renderer }
const update = async (renderer, props) => { await act(async () => renderer.update(React.createElement(Query, props))) }
const settle = async fn => { await act(async () => { fn?.(); await pause(8) }) }
const unmount = async renderer => { await act(async () => renderer.unmount()) }

test('classification only retries temporary read failures, never permissions or invalid filters', () => {
  for (const error of ['canceling statement due to statement timeout', 'Failed to fetch', 'network failure', 'gateway 504']) assert.equal(recovery.isTransientAptReadError(new Error(error)), true)
  for (const error of ['permission denied', 'JWT expired connection failed', 'No tiene acceso', 'invalid input syntax', 'invalid filters']) assert.equal(recovery.isTransientAptReadError(new Error(error)), false)
})
test('temporary failure has exactly one retry and terminates after the second failure', async () => {
  let attempts = 0
  const renderer = await mount(React.createElement(Query, { identity: 'A|same', read: async () => { attempts++; throw new Error('statement timeout') } }))
  await settle()
  assert.equal(attempts, 2); assert.equal(result.loading, false); assert.ok(result.error); assert.equal(result.data, null)
  await settle(); assert.equal(attempts, 2)
  await unmount(renderer)
})
test('refresh retains only same query, labels pending status, and permission failure clears retained data', async () => {
  const next = deferred(); let attempts = 0
  const read = () => ++attempts === 1 ? Promise.resolve({ stock: 42 }) : next.promise
  const renderer = await mount(React.createElement(Query, { identity: 'A|filters|page1', read }))
  assert.deepEqual(result.data, { stock: 42 }); const timestamp = result.receivedAt
  await act(async () => result.refresh())
  assert.equal(result.loading, true); assert.deepEqual(result.data, { stock: 42 }); assert.equal(result.receivedAt, timestamp)
  await settle(() => next.reject(new Error('permission denied')))
  assert.equal(result.data, null); assert.equal(result.loading, false); assert.equal(attempts, 2)
  await unmount(renderer)
})
test('failed transient refresh preserves exact previous result, then a successful explicit refresh recovers', async () => {
  let attempts = 0
  let success = false
  const read = async () => {
    attempts++
    if (attempts === 1) return { stock: 42 }
    if (success) return { stock: 43 }
    throw new Error('statement timeout')
  }
  const renderer = await mount(React.createElement(Query, { identity: 'A|same', read }))
  const oldTime = result.receivedAt
  await act(async () => result.refresh()); await settle()
  assert.equal(attempts, 3); assert.deepEqual(result.data, { stock: 42 }); assert.ok(result.error)
  assert.equal(result.receivedAt, oldTime); assert.equal(result.loading, false)
  success = true
  await act(async () => result.refresh())
  assert.equal(attempts, 4); assert.deepEqual(result.data, { stock: 43 }); assert.equal(result.error, null)
  await unmount(renderer)
})
test('changing filters or page hides old data immediately and late old requests cannot overwrite new query', async () => {
  const old = deferred(), fresh = deferred()
  const renderer = await mount(React.createElement(Query, { identity: 'A|filters1|page1', read: async () => ({ stock: 1 }) }))
  await update(renderer, { identity: 'A|filters1|page1', read: () => old.promise })
  await act(async () => result.refresh())
  await update(renderer, { identity: 'A|filters2|page2', read: () => fresh.promise })
  assert.equal(result.data, null); assert.equal(result.receivedAt, null)
  await settle(() => old.resolve({ stock: 999 }))
  assert.equal(result.data, null)
  await settle(() => fresh.resolve({ stock: 2 }))
  assert.deepEqual(result.data, { stock: 2 })
  await unmount(renderer)
})
test('canceling on query change or unmount prevents retry and stale publication', async () => {
  const failed = deferred()
  const renderer = await mount(React.createElement(Query, { identity: 'A|one', read: () => failed.promise }))
  await settle(() => failed.reject(new Error('statement timeout')))
  // Retry can already have started. A pending old result must still be ignored after a change.
  await update(renderer, { identity: 'A|two', read: async () => ({ stock: 2 }) })
  assert.deepEqual(result.data, { stock: 2 })
  const pending = deferred(); let shutdownAttempts = 0
  await update(renderer, { identity: 'A|three', read: () => { shutdownAttempts++; return pending.promise } })
  await unmount(renderer)
  await settle(() => pending.reject(new Error('statement timeout')))
  assert.equal(shutdownAttempts, 1)
  let tries = 0
  const stop = recovery.startRecoverableRead({ read: async () => { tries++; throw new Error('statement timeout') }, retryDelay: 30, onRetry() {}, onError() { assert.fail('published after cancellation') }, onSuccess() {} })
  await pause(1); stop(); await pause(40); assert.equal(tries, 1)
})
test('actual operational hook isolates users, ignores late getSession and shuts down auth/events', async () => {
  user = 'user-A'; getSessionOverride = null
  const pending = deferred(); let requests = 0
  apiRead = () => ++requests === 1 ? Promise.resolve({ stock: 10 }) : pending.promise
  const renderer = await mount(React.createElement(Operational))
  assert.deepEqual(result.data, { stock: 10 }); assert.equal(result.usable, true)
  await act(async () => result.refresh()); assert.equal(result.usable, false)
  apiRead = async () => ({ stock: 20 })
  await act(async () => authCallback('SIGNED_IN', { user: { id: 'user-B' } }))
  assert.deepEqual(result.data, { stock: 20 })
  await settle(() => pending.resolve({ stock: 999 }))
  assert.deepEqual(result.data, { stock: 20 })
  await act(async () => authCallback('SIGNED_OUT', null))
  assert.equal(result.data, null); assert.equal(result.authenticated, false); assert.equal(result.usable, false)
  await unmount(renderer); assert.equal(authCallback, null); assert.equal(listeners.size, 0)
  const initial = deferred(); getSessionOverride = initial.promise
  const second = await mount(React.createElement(Operational))
  await act(async () => authCallback('SIGNED_OUT', null))
  await settle(() => initial.resolve({ data: { session: { user: { id: 'user-A' } } } }))
  assert.equal(result.data, null); assert.equal(result.authenticated, false)
  await unmount(second); getSessionOverride = null
  assert.ok(cleared > 0)
})
test('StrictMode subscription recreation and repeated INITIAL_SESSION cannot strand loading', async () => {
  user = 'user-A'; getSessionOverride = null; synchronousInitialSession = true
  const old = deferred()
  let requests = 0
  apiRead = () => ++requests === 1 ? old.promise : Promise.resolve({ stock: 55 })
  const renderer = await mount(React.createElement(React.StrictMode, null, React.createElement(Operational)))
  await act(async () => authCallback('INITIAL_SESSION', { user: { id: 'user-A' } }))
  // Some renderer lifecycles issue their first request only after the replay.
  await settle(() => old.resolve({ stock: 55 }))
  assert.deepEqual(result.data, { stock: 55 }); assert.equal(result.loading, false); assert.equal(result.usable, true)
  const identity = result.key, count = requests
  await act(async () => authCallback('INITIAL_SESSION', { user: { id: 'user-A' } }))
  assert.equal(result.key, identity); assert.equal(requests, count); assert.equal(result.usable, true)
  await unmount(renderer); synchronousInitialSession = false
})
