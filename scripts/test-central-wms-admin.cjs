const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
function load(file, modules = {}, globals = {}) {
  const context = { exports: {}, URL, Request, Response, AbortSignal, ...globals, require(name) { if (name in modules) return modules[name]; throw Error(`Unexpected module ${name}`) } }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return context.exports
}
const validation = load('src/lib/wms-administration.ts')
const account = { first_name: 'Ana', last_name: 'Pérez', username: 'ana@jrmsac.com.pe', document_number: '12345678', phone: '', role_id: 'wms-role', is_active: false, password: 'initial-password' }
test('WMS account requires an explicit access state and role; validates credentials', () => {
  assert.equal(validation.validateWmsAccount(account, true).email, account.username)
  for (const changes of [{ is_active: undefined }, { role_id: '' }, { username: 'a@external.com' }, { password: 'short' }, { document_number: '' }]) assert.throws(() => validation.validateWmsAccount({ ...account, ...changes }, true))
  assert.doesNotThrow(() => validation.validateWmsAccount({ ...account, password: '' }, false))
})
test('WMS role cannot carry TMS permissions or omit warehouse access', () => {
  const role = { name: 'Recepción', description: '', permissions: ['almacen-lectura', 'almacen-etiquetado'] }
  assert.doesNotThrow(() => validation.validateWmsRole(role))
  for (const permissions of [['usuarios:write'], ['almacen-etiquetado'], ['almacen-lectura', 'permisos:write']]) assert.throws(() => validation.validateWmsRole({ ...role, permissions }))
})
function proxy(admin, fetcher) {
  return load('src/app/api/admin/wms/route.ts', {
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@/lib/server/system-admin': { getSystemAdminContext: async () => admin },
    '@/lib/supabase/server': { createClient: async () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'verified-tms-token' } } }) } }) },
  }, { fetch: fetcher })
}
test('unprivileged users cannot read or mutate WMS', async () => {
  const api = proxy(null, () => assert.fail('must not contact WMS'))
  assert.equal((await api.GET(new Request('https://tms.test/api/admin/wms'))).status, 403)
  assert.equal((await api.POST(new Request('https://tms.test/api/admin/wms', { method: 'POST' }))).status, 403)
})
test('cross-origin mutations are denied before forwarding', async () => {
  const api = proxy({}, () => assert.fail('must not contact WMS'))
  assert.equal((await api.POST(new Request('https://tms.test/api/admin/wms', { method: 'POST', headers: { origin: 'https://evil.test' } }))).status, 403)
})
test('only pinned WMS receives the verified TMS bearer token, with redirects disabled', async () => {
  let calls = 0
  const api = proxy({}, async (url, options) => {
    calls++
    assert.equal(url, 'https://wms.jrmlogistica.app/api/admin/wms')
    assert.equal(options.headers.Authorization, 'Bearer verified-tms-token')
    assert.equal(options.redirect, 'error')
    assert.equal(options.cache, 'no-store')
    assert.equal(JSON.parse(options.body).is_active, false)
    return Response.json({ success: true })
  })
  const response = await api.POST(new Request('https://tms.test/api/admin/wms', { method: 'POST', headers: { origin: 'https://tms.test', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'user', ...account }) }))
  assert.equal(response.status, 200); assert.equal(calls, 1)
})
test('unavailable WMS never reports success', async () => {
  const api = proxy({}, async () => new Response('<html>unavailable</html>'))
  const response = await api.GET(new Request('https://tms.test/api/admin/wms'))
  assert.equal(response.status, 503)
  assert.match((await response.json()).error, /No se confirmó/)
})
test('successful WMS directory includes TMS users resolved with the TMS schema', async () => {
  const person = { id: 'tms-person', username: 'ana@jrmsac.com.pe', first_name: 'Ana' }
  const admin = { adminClient: { from(table) {
    assert.equal(table, 'profiles')
    return { select(fields) { assert.ok(!fields.split(', ').includes('email')); return { order: () => ({ range: async () => ({ data: [person] }) }) } } }
  } } }
  const api = proxy(admin, async () => Response.json({ users: [], roles: [] }))
  const response = await api.GET(new Request('https://tms.test/api/admin/wms'))
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.equal(result.tmsUsers[0].id, 'tms-person')
  assert.equal(result.tmsUsers[0].username, person.username)
})
