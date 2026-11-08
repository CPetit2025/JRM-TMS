import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

// Trae del TMS las solicitudes de despacho (función de solo lectura con clave de integración) y le informa los
// Packing List liberados o reemplazados. Corre con la sesión del usuario del almacén: la base WMS decide si toca
// (máximo una vez por minuto) y valida permisos. La clave nunca llega al navegador.
async function tmsRpc(name: string, body: unknown) {
  const url = process.env.TMS_SUPABASE_URL, anon = process.env.TMS_SUPABASE_ANON_KEY
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST', cache: 'no-store',
    headers: { apikey: anon!, authorization: `Bearer ${anon}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`TMS ${name}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

export async function POST(request: Request) {
  const key = process.env.TMS_INTEGRATION_KEY
  if (!process.env.TMS_SUPABASE_URL || !process.env.TMS_SUPABASE_ANON_KEY || !key) {
    return Response.json({ ok: false, error: 'La integración con TMS no está configurada en este entorno.' }, { status: 503 })
  }
  const force = new URL(request.url).searchParams.get('forzar') === '1'
  const db = await createClient()
  const { data: known, error } = await db.rpc('wh_tms_sync_claim', { p_force: force })
  if (error) return Response.json({ ok: false, error: error.message }, { status: error.code === '42501' ? 403 : 500 })

  let synced: number | null = null
  let syncError = ''
  if (known !== null) {
    try {
      const rows = await tmsRpc('wms_feed_solicitudes', { p_key: key, p_known_ids: known })
      const applied = await db.rpc('wh_tms_sync_apply', { p_key: key, p_rows: rows })
      if (applied.error) throw new Error(applied.error.message)
      synced = applied.data?.requests ?? 0
    } catch (e) {
      syncError = e instanceof Error ? e.message : String(e)
      await db.rpc('wh_tms_sync_fail', { p_key: key, p_message: syncError })
    }
  }

  let reported = 0
  const pending = await db.rpc('wh_packing_lists_unreported')
  for (const row of (pending.data || []) as Array<{ id: string; status: string }>) {
    try {
      await tmsRpc('wms_report_packing_list', { p_key: key, p_row: row })
      await db.rpc('wh_packing_list_mark_reported', { p_id: row.id, p_status: row.status })
      reported++
    } catch (e) {
      syncError ||= e instanceof Error ? e.message : String(e)
    }
  }
  return Response.json({ ok: !syncError, synced, reported, error: syncError || undefined }, { status: syncError ? 502 : 200 })
}
