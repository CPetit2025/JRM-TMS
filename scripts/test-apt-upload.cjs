const {test} = require('node:test')
const assert = require('node:assert/strict')
const {readFileSync} = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const path = require('node:path')

function fixture(responses, status = 'CARGANDO') {
  const calls = [], rpc = []
  const source = ts.transpileModule(readFileSync(path.join(__dirname, '../src/lib/apt/api.ts'), 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText
  const context = {exports: {}, fetch: async (_, options) => {
    calls.push(JSON.parse(options.body).accion)
    const next = responses.shift()
    if (next instanceof Error) throw next
    return {status: next.status || 200, ok: !next.status || next.status < 400, json: async () => next}
  }, require: () => ({createClient: () => ({rpc: async (name) => {rpc.push(name); throw Error('Unsafe browser RPC')}, from: () => ({select: () => ({eq: () => ({maybeSingle: async () => ({data: {status, summary: {entrada: {validas: 154}}}, error: null})})})})})})}
  vm.runInNewContext(source, context)
  return {api: context.exports.aptApi, calls, rpc}
}

test('configured server applies once and recalculates both models', async () => {
  const f = fixture([{success: true, summary: {entrada: {validas:154}}}, {success:true,model:1}, {success:true,flow:2}])
  const result = await f.api.uploadApply('upload')
  assert.equal(result.warning, null)
  assert.deepEqual(f.calls, ['aplicar','estadia','flujo'])
  assert.deepEqual(f.rpc, [])
})
test('missing server and lost connection never switch to browser RPC', async () => {
  for (const failure of [{status:503},{status:404},new Error('network'),{status:504},{status:400,error:'statement timeout'}]) {
    const f=fixture([failure])
    await assert.rejects(f.api.uploadApply('upload'))
    assert.deepEqual(f.calls,['aplicar'])
    assert.deepEqual(f.rpc,[])
  }
})
test('committed upload survives a lost response without a second replacement', async () => {
  const f=fixture([new Error('network'),{success:true},{success:true}],'APLICADA')
  assert.equal((await f.api.uploadApply('upload')).warning,null)
  assert.deepEqual(f.calls,['aplicar','estadia','flujo'])
})
test('FIFO timeout still rebuilds the independent flow and reports its pending step', async () => {
  const f=fixture([{success:true,summary:{entrada:{validas:154}}},{status:500,error:'statement timeout'},{success:true,flow:2}])
  const result=await f.api.uploadApply('upload')
  assert.equal(result.summary.entrada.validas,154)
  assert.match(result.warning,/carga está aplicada/)
  assert.deepEqual(f.calls,['aplicar','estadia','flujo'])
})
test('flow failure never implies that committed movements were discarded', async () => {
  const f=fixture([{success:true,summary:{}},{success:true},{status:504}])
  assert.match((await f.api.uploadApply('upload')).warning,/recálculo quedó pendiente/)
  assert.deepEqual(f.rpc,[])
})
test('retry only recalculates and cannot apply, send or discard movements', async () => {
  const f=fixture([{success:true,model:1},{success:true,flow:2}])
  await f.api.rebuildModels()
  assert.deepEqual(f.calls,['estadia','flujo'])
  assert.deepEqual(f.rpc,[])
})

test('failed retry attempts both independent steps, reports both failures and never reapplies', async () => {
  const f=fixture([{status:500,error:'estadia pendiente'},{status:500,error:'flujo pendiente'}])
  await assert.rejects(f.api.rebuildModels(), /estadia pendiente.*flujo pendiente/)
  assert.deepEqual(f.calls,['estadia','flujo'])
  assert.deepEqual(f.rpc,[])
})

test('a flow that the scheduled job finishes is pending, not a failure', async () => {
  const f = fixture([{success: true, summary: {}}, {success: true, model: 1}, {success: true, pending: true}])
  const result = await f.api.uploadApply('upload')
  assert.equal(result.warning, null)
  assert.equal(result.pending, true)
  assert.deepEqual(f.calls, ['aplicar', 'estadia', 'flujo'])
})

// Ruta del servidor: estadía o flujo cortados por el límite de 120 s quedan «pendientes» (los termina la tarea programada)
async function route(rpcResult) {
  const source = ts.transpileModule(readFileSync(path.join(__dirname, '../src/app/api/apt/procesar/route.ts'), 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText
  const json = (body, init) => ({status: init?.status || 200, body})
  const mods = {
    'next/server': {NextResponse: {json}},
    '@/lib/supabase/server': {createClient: async () => ({auth: {getUser: async () => ({data: {user: {id: 'u'}}})}, rpc: async () => ({data: {success: true, can_load: true}})})},
    '@supabase/supabase-js': {createClient: () => ({rpc: async () => rpcResult})},
  }
  const context = {exports: {}, process: {env: {SUPABASE_SERVICE_ROLE_KEY: 'k', NEXT_PUBLIC_SUPABASE_URL: 'u'}}, require: n => mods[n]}
  vm.runInNewContext(source, context)
  return accion => context.exports.POST({json: async () => ({accion})})
}
test('server route reports a timed-out rebuild as pending and other errors as failures', async () => {
  const timeout = await route({error: {message: 'canceling statement due to statement timeout'}, data: null})
  for (const accion of ['estadia', 'flujo']) assert.deepEqual({...(await timeout(accion)).body}, {success: true, pending: true})
  const broken = await route({error: {message: 'relation does not exist'}, data: null})
  const r = await broken('flujo')
  assert.equal(r.status, 500); assert.equal(r.body.success, false)
})
