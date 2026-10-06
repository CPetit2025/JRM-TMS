const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const ts = require('typescript')
const vm = require('node:vm')
const path = require('node:path')

const roleContext = { exports: {} }
vm.runInNewContext(ts.transpileModule(readFileSync(path.join(__dirname, '../src/lib/roles.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, roleContext)

function fixture({ user = { id: 'user1' }, profile = { is_active: true, employee_type: 'CONDUCTOR' }, driver = { is_active: true }, refresh = true } = {}) {
  const queries = []
  const response = (location) => ({ location, cookies: { items: [], set(cookie, value, options) { this.items.push(typeof cookie === 'string' ? { name: cookie, value, ...options } : cookie) }, getAll() { return this.items } } })
  const source = ts.transpileModule(readFileSync(path.join(__dirname, '../src/proxy.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const context = { exports: {}, process: { env: {} }, URL, require(name) {
    if (name === 'next/server') return { NextResponse: { next: () => response(), redirect: url => response(url.pathname) } }
    if (name === '@/lib/roles') return roleContext.exports
    if (name === '@supabase/ssr') return { createServerClient: (_, __, options) => ({
      auth: { getUser: async () => {
        if (refresh) options.cookies.setAll([{ name: 'session', value: user ? 'refreshed' : '', options: { secure: true, maxAge: user ? 3600 : 0 } }])
        return { data: { user } }
      } },
      from: table => { queries.push(table); return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === 'profiles' ? profile : driver }) }) }) } },
    }) }
    throw Error(name)
  } }
  vm.runInNewContext(source, context)
  return { queries, request: async (pathname) => {
    const url = new URL(`https://jrm-tms.vercel.app${pathname}`)
    url.clone = () => new URL(url)
    return context.exports.proxy({ url: url.href, nextUrl: url, cookies: { getAll: () => [], set() {} } })
  } }
}

test('driver with valid saved session bypasses APK login', async () => {
  const result = await fixture().request('/app/login')
  assert.equal(result.location, '/app')
  assert.deepEqual(result.cookies.items.map(c => [c.name, c.value, c.secure]), [['session', 'refreshed', true]])
})
test('operative account resumes activities with no duplicate profile query', async () => {
  const client = fixture({ profile: { is_active: true, employee_type: 'OPERARIO' } })
  assert.equal((await client.request('/app/login')).location, '/app/actividades')
  assert.deepEqual(client.queries, ['profiles'])
})
test('missing, inactive or unlinked driver cannot resume session', async () => {
  for (const options of [{ user: null }, { profile: null }, { profile: { is_active: false } }, { driver: null }, { driver: { is_active: false } }]) {
    assert.equal((await fixture(options).request('/app/login')).location, undefined)
  }
})
test('protected route rejects invalid session and carries expired cookie removal', async () => {
  const result = await fixture({ user: null }).request('/app/ruta')
  assert.equal(result.location, '/app/login')
  assert.equal(result.cookies.items[0].value, '')
  assert.equal(result.cookies.items[0].maxAge, 0)
})
test('revoked driver and inactive profile redirect without an infinite login loop', async () => {
  for (const options of [{ driver: { is_active: false } }, { profile: { is_active: false } }]) {
    assert.equal((await fixture(options).request('/app/ruta')).location, '/app/login')
    assert.equal((await fixture(options).request('/app/login')).location, undefined)
  }
})
test('valid operative page retains refreshed session cookies', async () => {
  const result = await fixture().request('/app/ruta')
  assert.equal(result.location, undefined)
  assert.equal(result.cookies.items[0].value, 'refreshed')
})
