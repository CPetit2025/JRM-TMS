// Ruta /api/wms/sincronizar: informa al TMS el estado de picking/auditoría de cada solicitud (la salida del despacho
// en el TMS espera LIBERADO). Sin red ni base: Supabase y fetch simulados.
const assert = require('node:assert/strict')
const ts = require('typescript')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const { test } = require('node:test')

function route({ known, pl = [], states = [], tmsFails = '' }) {
  const rpcs = [], posts = []
  const db = { rpc: async (name) => {
    rpcs.push(name)
    if (name === 'wh_tms_sync_claim') return { data: known, error: null }
    if (name === 'wh_tms_sync_apply') return { data: { requests: 1 }, error: null }
    if (name === 'wh_packing_lists_unreported') return { data: pl, error: null }
    if (name === 'wh_tms_request_states') return { data: states, error: null }
    return { data: null, error: null }
  } }
  const fetch = async (url, init) => {
    const name = url.split('/rpc/')[1], body = JSON.parse(init.body)
    posts.push({ name, body })
    if (tmsFails && name === tmsFails) return { ok: false, text: async () => 'función no existe' }
    return { ok: true, text: async () => (name === 'wms_feed_solicitudes' ? '[]' : '{"success":true}') }
  }
  const context = { exports: {}, process: { env: { TMS_SUPABASE_URL: 'https://tms', TMS_SUPABASE_ANON_KEY: 'anon', TMS_INTEGRATION_KEY: 'k'.repeat(40) } },
    fetch, URL, AbortSignal, JSON, Error, String, Response: { json: (body, init) => ({ body, status: init?.status ?? 200 }) },
    require: name => { if (name === '@/lib/supabase/server') return { createClient: async () => db }; return require(name) } }
  vm.runInNewContext(ts.transpileModule(readFileSync('src/app/api/wms/sincronizar/route.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return { POST: () => context.exports.POST({ url: 'https://wms/api/wms/sincronizar' }), rpcs, posts }
}

test('cada sincronización informa los estados con la clave (también es el latido)', async () => {
  const r = route({ known: [], states: [{ transport_request_id: 'a', status: 'LIBERADO', snapshot_at: 'x' }] })
  const res = await r.POST()
  assert.equal(res.status, 200); assert.equal(res.body.states, 1)
  const report = r.posts.find(p => p.name === 'wms_report_request_status')
  assert.deepEqual(report.body, { p_key: 'k'.repeat(40), p_rows: [{ transport_request_id: 'a', status: 'LIBERADO', snapshot_at: 'x' }] })
})

test('un Packing List recién informado dispara el estado aunque no toque sincronizar', async () => {
  const r = route({ known: null, pl: [{ id: 'pl', status: 'LIBERADO' }] })
  await r.POST()
  assert.ok(r.posts.some(p => p.name === 'wms_report_request_status'))
  const idle = route({ known: null })
  await idle.POST()
  assert.ok(!idle.rpcs.includes('wh_tms_request_states'), 'sin turno ni novedades no llama')
})

test('si el TMS no responde el error se muestra (el TMS sigue bloqueando la salida)', async () => {
  const r = route({ known: [], tmsFails: 'wms_report_request_status' })
  const res = await r.POST()
  assert.equal(res.status, 502); assert.match(res.body.error, /wms_report_request_status/)
})
