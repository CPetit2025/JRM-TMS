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
test('FIFO timeout reports applied upload with pending recalculation', async () => {
  const f=fixture([{success:true,summary:{entrada:{validas:154}}},{status:500,error:'statement timeout'}])
  const result=await f.api.uploadApply('upload')
  assert.equal(result.summary.entrada.validas,154)
  assert.match(result.warning,/carga está aplicada/)
  assert.deepEqual(f.calls,['aplicar','estadia'])
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
