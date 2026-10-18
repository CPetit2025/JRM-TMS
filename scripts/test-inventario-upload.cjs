const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const source = ts.transpileModule(readFileSync('src/lib/inventario/api.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
function fixture(rpcHandler, serverHandler = () => ({ success: true })) {
  const calls = [], server = [], exports = {}
  vm.runInNewContext(source, {
    exports, require: () => ({ createClient: () => ({ rpc: async (fn, args) => { calls.push({ fn, args }); return rpcHandler(fn, args) } }) }),
    fetch: async (_, init) => { const body = JSON.parse(init.body); server.push(body); return { json: async () => serverHandler(body) } },
    setTimeout: fn => fn(), TypeError, Error, window: { dispatchEvent() {} }, Event: class {},
  })
  return { api: exports, calls, server }
}
const part = (count = 1201) => ({ side: 'E', fileName: 'ERP.xlsx', sheetName: 'ENTRADA', rows: Array.from({ length: count }, (_, i) => ({ __row: i + 2, Cantidad: 1 })) })
const ok = fn => ({ data: fn === 'inv_upload_begin' ? { upload_id: 'id-1' } : { success: true } })
test('sends bounded chunks, reports progress, and never repeats a successfully applied side', async () => {
  const f = fixture(ok), p = part(), progress = []
  await f.api.uploadPart(p, { onProgress: m => progress.push(m) }); await f.api.uploadPart(p, {})
  assert.deepEqual(f.calls.filter(x => x.fn === 'inv_upload_rows').map(x => x.args.p_rows.length), [500, 500, 201])
  assert.equal(f.calls.filter(x => x.fn === 'inv_upload_begin').length, 1)
  assert.equal(f.server.length, 1); assert.ok(progress.some(x => x.includes('100 %')))
})
test('timeout retries same block; after exhausted retries resumes without discarding or resending confirmed rows', async () => {
  let fail = true
  const f = fixture((fn, args) => fn === 'inv_upload_rows' && args.p_rows[0].__row === 502 && fail
    ? { error: { code: '57014', message: 'canceling statement due to statement timeout' } } : ok(fn))
  const p = part()
  await assert.rejects(f.api.uploadPart(p, {}), /statement timeout/)
  assert.equal(f.calls.filter(x => x.fn === 'inv_upload_rows' && x.args.p_rows[0].__row === 502).length, 3)
  fail = false; await f.api.uploadPart(p, {})
  assert.equal(f.calls.filter(x => x.fn === 'inv_upload_rows' && x.args.p_rows[0].__row === 2).length, 1)
  assert.equal(f.calls.filter(x => x.fn === 'inv_upload_begin').length, 1)
  assert.equal(f.calls.filter(x => x.fn === 'inv_upload_discard').length, 0)
})
test('lost apply response retries apply with same upload, never restages rows', async () => {
  let fail = true
  const f = fixture(ok, () => { if (fail) throw new TypeError('network'); return { success: true, replayed: true } }), p = part(1)
  await assert.rejects(f.api.uploadPart(p, {})); fail = false; await f.api.uploadPart(p, {})
  assert.equal(f.calls.filter(x => x.fn === 'inv_upload_rows').length, 1)
  assert.equal(f.server[0].upload_id, f.server[1].upload_id)
})
test('does not retry authorization failures and preserves partial-report confirmation', async () => {
  const denied = fixture(fn => fn === 'inv_upload_rows' ? { error: { code: '42501', message: 'denied' } } : ok(fn))
  await assert.rejects(denied.api.uploadPart(part(1), {}), /denied/)
  assert.equal(denied.calls.filter(x => x.fn === 'inv_upload_rows').length, 1)
  const f = fixture(ok, body => body.force ? { success: true } : { success: false, partial: true, error: 'partial' }), p = part(1)
  await assert.rejects(f.api.uploadPart(p, {}), e => e.partial === true)
  await f.api.uploadPart(p, { force: true })
  assert.equal(f.calls.filter(x => x.fn === 'inv_upload_rows').length, 1)
})
