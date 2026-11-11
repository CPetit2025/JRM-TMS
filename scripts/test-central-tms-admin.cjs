const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
function load(profile, authenticated = true, bearer = 'Bearer tms-token', url = 'https://eojfsbogysifxrlrnjvx.supabase.co') {
  let calls = 0
  const context = { exports: {}, URL, process: { env: { TMS_SUPABASE_URL: url, TMS_SUPABASE_ANON_KEY: 'public-key' } }, require(name) {
    if (name === 'server-only') return {}
    if (name === 'next/headers') return { headers: async () => ({ get: () => bearer }) }
    if (name === '@/lib/roles') return { isSystemAdminRole: name => name === 'Administrador' }
    if (name === '@supabase/supabase-js') return { createClient(target) {
      calls++; assert.equal(target, 'https://eojfsbogysifxrlrnjvx.supabase.co')
      return { auth: { getUser: async token => { assert.equal(token, 'tms-token'); return { data: { user: authenticated ? { id: 'tms-admin' } : null } } } }, from: table => { assert.equal(table, 'profiles'); return { select: () => ({ eq: (_, id) => { assert.equal(id, 'tms-admin'); return { maybeSingle: async () => ({ data: profile }) } } }) } } }
    } }
    throw Error(name)
  } }
  vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/server/central-tms-admin.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return { auth: context.exports.getSystemAdminContext, calls: () => calls }
}
test('missing bearer does not reach either database', async () => { const api = load(null, true, null); assert.equal(await api.auth(), null); assert.equal(api.calls(), 0) })
test('invalid JWT cannot access WMS', async () => { assert.equal(await load(null, false).auth(), null) })
test('inactive or non-admin TMS profiles cannot access WMS', async () => { for (const p of [{ is_active: false, roles: { name: 'Administrador' } }, { is_active: true, roles: { name: 'Auditor de Despacho' } }, null]) assert.equal(await load(p).auth(), null) })
test('active TMS admin is authorized', async () => { assert.equal((await load({ is_active: true, roles: { name: 'Administrador' } }).auth()).user.id, 'tms-admin') })
test('wrong TMS integration target fails before forwarding credentials', async () => { const api = load(null, true, 'Bearer tms-token', 'https://other.supabase.co'); await assert.rejects(api.auth(), /no configurada/); assert.equal(api.calls(), 0) })
