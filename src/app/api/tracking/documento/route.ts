import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

// Portal público de seguimiento: entrega guías de remisión, Packing List y fotos de la guía firmada validada.
// La base valida el enlace, el código (con límite de intentos) y que el archivo pertenezca al alcance autorizado
// (get_public_tracking_document, solo rol de servicio); aquí se firma una URL de corta duración.
export const maxDuration = 15

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers })

export async function POST(request: Request) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) return json({ success: false, error: 'Portal temporalmente no disponible' }, 503)
  let body: { token?: unknown; pin?: unknown; kind?: unknown; id?: unknown; request_id?: unknown; index?: unknown }
  try { body = await request.json() } catch { return json({ success: false, error: 'Solicitud no válida' }, 400) }
  const { token, pin, kind, id } = body
  const requestId = body.request_id ?? null
  const index = body.index ?? 1
  if (typeof token !== 'string' || !UUID.test(token) || typeof pin !== 'string' || !/^\d{8}$/.test(pin)
    || (kind !== 'DOC' && kind !== 'FIRMA') || typeof id !== 'string' || !UUID.test(id)
    || (requestId !== null && (typeof requestId !== 'string' || !UUID.test(requestId)))
    || typeof index !== 'number' || !Number.isInteger(index) || index < 1 || index > 5) {
    return json({ success: false, error: 'Solicitud no válida' }, 400)
  }
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data, error } = await admin.rpc('get_public_tracking_document', {
    p_token: token, p_pin: pin, p_kind: kind, p_id: id, p_request: requestId, p_index: index,
  })
  if (error) return json({ success: false, error: 'No se pudo consultar el documento' }, 503)
  if (!data || data.error) return json({ success: false, error: data?.error || 'Documento no disponible' }, 403)
  const signed = await admin.storage.from(data.bucket).createSignedUrl(data.path, 300)
  if (signed.error || !signed.data?.signedUrl) return json({ success: false, error: 'El archivo no está disponible' }, 404)
  return json({ success: true, url: signed.data.signedUrl, name: data.name })
}
