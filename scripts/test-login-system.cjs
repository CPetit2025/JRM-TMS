const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const ts = require('typescript')
const vm = require('node:vm')
const React = require('react')
const renderer = require('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT = true

function load(file, modules = {}, globals = {}) {
  const context = { exports: {}, URL, Error, ...globals, require(name) {
    if (name in modules) return modules[name]
    throw Error(`Unexpected module: ${name}`)
  } }
  const result = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    reportDiagnostics: true,
  })
  assert.deepEqual(result.diagnostics, [])
  vm.runInNewContext(result.outputText, context)
  return context.exports
}
const routing = load('src/lib/login-system.ts')
const tms = 'https://eojfsbogysifxrlrnjvx.supabase.co'
const staging = 'https://rquujukgtturdlkuzgdc.supabase.co'
const production = 'https://glecgvomkaqmkfkhtxhi.supabase.co'

test('database determines the local system, including WMS preview without a mode flag', () => {
  assert.equal(routing.loginSystemForDatabase(tms), 'tms')
  for (const url of [staging, production]) assert.equal(routing.loginSystemForDatabase(url), 'almacen')
  for (const url of [undefined, 'bad', tms + '.evil.test', 'http://eojfsbogysifxrlrnjvx.supabase.co']) {
    assert.equal(routing.loginSystemForDatabase(url), null)
  }
})
test('remote access uses fixed login paths and refuses missing, unsafe or looping origins', () => {
  assert.equal(routing.remoteLoginUrl('tms', undefined, 'https://wms.example.com'), 'https://jrm-tms.vercel.app/login')
  assert.equal(routing.remoteLoginUrl('almacen', 'https://wms.example.com', 'https://tms.example.com'), 'https://wms.example.com/almacen/login')
  for (const url of [undefined, '', 'javascript:alert(1)', 'http://wms.example.com', 'https://user:pass@wms.example.com', 'https://wms.example.com/path', 'https://wms.example.com?token=secret', 'https://wms.example.com#token', 'https://tms.example.com']) {
    assert.throws(() => routing.remoteLoginUrl('almacen', url, 'https://tms.example.com'))
  }
})

async function fixture(database, env = {}) {
  const authCalls = [], navigations = [], errors = []
  const client = { auth: {
    signInWithPassword: async data => { authCalls.push(data); return { error: { message: 'test' } } },
    resetPasswordForEmail: async () => { throw Error('Unexpected reset') },
  } }
  const stub = () => null
  const page = load('src/app/login/page.tsx', {
    'react': React,
    'react/jsx-runtime': require('react/jsx-runtime'),
    'next/navigation': { usePathname: () => '/login', useRouter: () => ({ push: stub }) },
    'lucide-react': { Loader2: stub, Download: stub },
    'sonner': { toast: { error: message => errors.push(message), success: stub } },
    '@/lib/supabase/client': { createClient: () => client },
    '@/components/AppVersionInfo': { AppVersionInfo: stub },
    '@/components/forms/PublicRegistrationModal': { PublicRegistrationModal: stub },
    '@/lib/roles': { isDispatchAuditorRole: stub, normalizeRoleName: value => value },
    '@/lib/nav/web-access': { hasWebAccess: stub },
    '@/lib/login-system': routing,
    '@/lib/use-cached': { clearCache: () => {} },
  }, {
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: database, ...env } },
    window: { location: { origin: 'https://current.example.com', assign: value => navigations.push(value) } },
    fetch: async () => ({ json: async () => ({}) }),
  })
  let tree
  await renderer.act(async () => { tree = renderer.create(React.createElement(page.default)) })
  return {
    tree, authCalls, navigations, errors,
    async select(system) { await renderer.act(async () => tree.root.findByType('select').props.onChange({ target: { value: system } })) },
    async submit() { await renderer.act(async () => tree.root.findByType('form').props.onSubmit({ preventDefault() {} })) },
    async cleanup() { await renderer.act(async () => tree.unmount()) },
  }
}

test('WMS preview defaults to Almacén and switching to TMS never authenticates against WMS', async () => {
  const f = await fixture(staging)
  try {
    assert.equal(f.tree.root.findByType('select').props.value, 'almacen')
    assert.equal(f.tree.root.findAllByProps({ id: 'login-password' }).length, 1)
    await f.select('tms')
    assert.equal(f.tree.root.findAllByProps({ id: 'login-password' }).length, 0)
    await f.submit()
    assert.deepEqual(f.navigations, ['https://jrm-tms.vercel.app/login'])
    assert.deepEqual(f.authCalls, [])
  } finally { await f.cleanup() }
})
test('TMS sends Almacén to its configured origin without forwarding typed credentials', async () => {
  const f = await fixture(tms, { NEXT_PUBLIC_WMS_ORIGIN: 'https://wms.example.com' })
  try {
    await renderer.act(async () => {
      f.tree.root.findByProps({ id: 'login-username' }).props.onChange({ target: { value: 'operator@example.com' } })
      f.tree.root.findByProps({ id: 'login-password' }).props.onChange({ target: { value: 'private-password' } })
    })
    await f.select('almacen')
    await f.submit()
    assert.deepEqual(f.navigations, ['https://wms.example.com/almacen/login'])
    assert.deepEqual(f.authCalls, [])
    await f.select('tms')
    assert.equal(f.tree.root.findByProps({ id: 'login-username' }).props.value, '')
    assert.equal(f.tree.root.findByProps({ id: 'login-password' }).props.value, '')
    await f.submit()
    assert.equal(f.authCalls.length, 2) // Existing corporate-domain fallback after a rejected login.
  } finally { await f.cleanup() }
})
test('missing WMS address and unknown databases fail closed without authenticating', async () => {
  for (const database of [tms, 'https://unknown.supabase.co']) {
    const f = await fixture(database)
    try {
      await f.select('almacen')
      await f.submit()
      assert.equal(f.errors.length, 1)
      assert.deepEqual(f.authCalls, [])
      assert.deepEqual(f.navigations, [])
    } finally { await f.cleanup() }
  }
})
