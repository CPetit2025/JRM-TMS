import type { SupabaseClient } from '@supabase/supabase-js'

// Sincronización WMS ⇄ TMS. La usan la ruta del navegador (sesión del usuario del almacén) y el cron del servidor
// (llave de servicio de la base WMS, sin navegador). Trae del TMS las solicitudes de despacho (feed de solo lectura con
// clave de integración), le informa los Packing List y el estado de picking/auditoría de cada solicitud: el TMS no
// deja salir el despacho hasta que esté LIBERADO. La clave nunca llega al navegador.
const STATE_BATCH = 1000

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

export function tmsSyncConfigured() {
  return Boolean(process.env.TMS_SUPABASE_URL && process.env.TMS_SUPABASE_ANON_KEY && process.env.TMS_INTEGRATION_KEY)
}

export async function syncWithTms(db: SupabaseClient, force: boolean): Promise<{ status: number; body: Record<string, unknown> }> {
  const key = process.env.TMS_INTEGRATION_KEY
  if (!tmsSyncConfigured() || !key) {
    return { status: 503, body: { ok: false, error: 'La integración con TMS no está configurada en este entorno.' } }
  }
  const { data: known, error } = await db.rpc('wh_tms_sync_claim', { p_force: force })
  if (error) return { status: error.code === '42501' ? 403 : 500, body: { ok: false, error: error.message } }

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
      await db.rpc('wh_packing_list_mark_reported', { p_key: key, p_id: row.id, p_status: row.status })
      reported++
    } catch (e) {
      syncError ||= e instanceof Error ? e.message : String(e)
    }
  }

  // Estado por solicitud: todas las tareas activas y las cerradas desde el último envío confirmado, en lotes. Va en
  // cada turno (también es el latido: sin él, el TMS muestra «Sin respuesta del WMS») y apenas se informa un Packing List.
  let states: number | null = null
  if (known !== null || reported > 0) {
    try {
      const result = await db.rpc('wh_tms_request_states')
      if (result.error) throw new Error(result.error.message)
      const rows = (result.data || []) as Array<{ snapshot_at?: string }>
      for (let i = 0; i < rows.length || i === 0; i += STATE_BATCH) {
        await tmsRpc('wms_report_request_status', { p_key: key, p_rows: rows.slice(i, i + STATE_BATCH) })
      }
      if (rows[0]?.snapshot_at) {
        const marked = await db.rpc('wh_tms_states_mark_sent', { p_key: key, p_at: rows[0].snapshot_at })
        if (marked.error) throw new Error(marked.error.message)
      }
      states = rows.length
    } catch (e) {
      syncError ||= e instanceof Error ? e.message : String(e)
    }
  }
  return { status: syncError ? 502 : 200, body: { ok: !syncError, synced, reported, states, error: syncError || undefined } }
}
