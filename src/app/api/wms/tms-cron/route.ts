import { timingSafeEqual } from 'node:crypto'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { syncWithTms } from '@/lib/server/tms-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Vercel Cron (vercel.json, cada 5 min): sincroniza con el TMS aunque no haya ninguna pantalla del almacén abierta,
// para que la liberación y el latido lleguen y el TMS no bloquee la salida por «Sin respuesta del WMS».
// Requiere en el proyecto Vercel jrm-wms: CRON_SECRET (Vercel lo envía como «Authorization: Bearer …») y
// SUPABASE_SERVICE_ROLE_KEY de la base WMS, además de las variables TMS_* de la integración.
function authorized(header: string | null) {
  const secret = process.env.CRON_SECRET
  if (!secret || secret.length < 16 || !header) return false
  const expected = Buffer.from(`Bearer ${secret}`), given = Buffer.from(header)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

export async function GET(request: Request) {
  if (!authorized(request.headers.get('authorization'))) return Response.json({ ok: false, error: 'No autorizado' }, { status: 401 })
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey || !process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return Response.json({ ok: false, error: 'Configuración del servidor incompleta' }, { status: 503 })
  }
  const db = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { status, body } = await syncWithTms(db, false)
  return Response.json(body, { status })
}
