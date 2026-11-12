// Sincronización WMS → TMS (src/lib/server/tms-sync.ts) desde la ruta del navegador y desde el cron del servidor:
// estado de picking/auditoría por solicitud (la salida en el TMS espera LIBERADO), lotes, confirmación y CRON_SECRET.
// Sin red ni base: Supabase y fetch simulados.
const assert = require('node:assert/strict')
const ts = require('typescript')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const { test } = require('node:test')

const KEY = 'k'.repeat(40), SECRET = 's'.repeat(32)
function load(file, context) {
  vm.runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context)
  return context.exports
}
function setup({ known, pl = [], states = [], tmsFails = '', env = {} }) {
  const rpcs = [], posts = [], clients = []
  const db = { rpc: async (name, args) => {
    rpcs.push({ name, args })
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
  const process = { env: { TMS_SUPABASE_URL: 'https://tms', TMS_SUPABASE_ANON_KEY: 'anon', TMS_INTEGRATION_KEY: KEY,
    NEXT_PUBLIC_SUPABASE_URL: 'https://wms', SUPABASE_SERVICE_ROLE_KEY: 'service', CRON_SECRET: SECRET, ...env } }
  const base = { exports: {}, process, fetch, URL, AbortSignal, JSON, Error, String, Boolean, Buffer,
    Response: { json: (body, init) => ({ body, status: init?.status ?? 200 }) } }
  const lib = load('src/lib/server/tms-sync.ts', { ...base, exports: {}, require })
  const req = name => {
    if (name === '@/lib/server/tms-sync') return lib
    if (name === '@/lib/supabase/server') return { createClient: async () => { clients.push('session'); return db } }
    if (name === '@supabase/supabase-js') return { createClient: (url, key) => { clients.push(`admin:${url}:${key}`); return db } }
    return require(name)
  }
  return {
    sync: () => load('src/app/api/wms/sincronizar/route.ts', { ...base, exports: {}, require: req }).POST({ url: 'https://wms/api/wms/sincronizar' }),
    cron: auth => load('src/app/api/wms/tms-cron/route.ts', { ...base, exports: {}, require: req })
      .GET({ url: 'https://wms/api/wms/tms-cron', headers: { get: h => (h === 'authorization' ? auth ?? null : null) } }),
    rpcs, posts, clients,
  }
}

test('cada sincronización informa los estados con la clave, en lotes, y confirma la foto', async () => {
  const states = Array.from({ length: 2500 }, (_, i) => ({ transport_request_id: `r${i}`, status: 'EN_PICKING', snapshot_at: '2026-11-12T10:00:00Z' }))
  const r = setup({ known: [], states })
  const res = await r.sync()
  assert.equal(res.status, 200); assert.equal(res.body.states, 2500)
  const reports = r.posts.filter(p => p.name === 'wms_report_request_status')
  assert.deepEqual(reports.map(p => p.body.p_rows.length), [1000, 1000, 500], 'sin tope: todas las tareas, en lotes')
  assert.ok(reports.every(p => p.body.p_key === KEY))
  assert.deepEqual({ ...r.rpcs.find(c => c.name === 'wh_tms_states_mark_sent').args }, { p_key: KEY, p_at: '2026-11-12T10:00:00Z' })
  assert.deepEqual(r.clients, ['session'])
})

test('sin tareas igual envía el latido; un Packing List recién informado dispara el estado', async () => {
  const empty = setup({ known: [] })
  await empty.sync()
  assert.deepEqual(empty.posts.filter(p => p.name === 'wms_report_request_status').map(p => p.body.p_rows), [[]])
  const r = setup({ known: null, pl: [{ id: 'pl', status: 'LIBERADO' }] })
  await r.sync()
  assert.ok(r.posts.some(p => p.name === 'wms_report_request_status'))
  const idle = setup({ known: null })
  await idle.sync()
  assert.ok(!idle.rpcs.some(c => c.name === 'wh_tms_request_states'), 'sin turno ni novedades no llama')
})

test('si el TMS no responde se informa el error y no se confirma la foto (el TMS sigue bloqueando)', async () => {
  const r = setup({ known: [], states: [{ transport_request_id: 'a', status: 'LIBERADO', snapshot_at: 'x' }], tmsFails: 'wms_report_request_status' })
  const res = await r.sync()
  assert.equal(res.status, 502); assert.match(res.body.error, /wms_report_request_status/)
  assert.ok(!r.rpcs.some(c => c.name === 'wh_tms_states_mark_sent'))
})

test('cron del servidor: sin secreto o con secreto errado 401; con secreto sincroniza con la llave de servicio', async () => {
  for (const auth of [undefined, 'Bearer otro-secreto-otro-secreto-xx', `Bearer ${SECRET}x`]) {
    const r = setup({ known: [] })
    assert.equal((await r.cron(auth)).status, 401)
    assert.equal(r.posts.length, 0, 'no llama al TMS')
  }
  const unset = setup({ known: [], env: { CRON_SECRET: '' } })
  assert.equal((await unset.cron('Bearer ')).status, 401, 'sin CRON_SECRET configurado no se abre')
  const r = setup({ known: [], states: [{ transport_request_id: 'a', status: 'LIBERADO', snapshot_at: 'x' }] })
  const res = await r.cron(`Bearer ${SECRET}`)
  assert.equal(res.status, 200)
  assert.deepEqual(r.clients, ['admin:https://wms:service'])
  assert.ok(r.posts.some(p => p.name === 'wms_feed_solicitudes') && r.posts.some(p => p.name === 'wms_report_request_status'))
})
