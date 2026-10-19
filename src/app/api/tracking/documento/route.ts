import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { createClient as createSessionClient } from '@/lib/supabase/server'

// Portal público de seguimiento: entrega el Packing List y la guía de remisión que sube el conductor (app o enlace).
// La base valida el enlace, el código (con límite de intentos) y que el archivo pertenezca al alcance autorizado
// (get_public_tracking_document, solo rol de servicio); aquí se firma una URL de corta duración.
// Desde el TMS (Seguimiento de transporte, sin código) llega la sede en lugar del enlace: se verifica la sesión y el
// acceso a la sede, y se usa el enlace interno de esa sede, cuyo código nunca sale del servidor.
export const maxDuration = 15

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers })

export async function POST(request: Request) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) return json({ success: false, error: 'Portal temporalmente no disponible' }, 503)
  let body: { token?: unknown; pin?: unknown; site?: unknown; kind?: unknown; id?: unknown; request_id?: unknown; index?: unknown }
  try { body = await request.json() } catch { return json({ success: false, error: 'Solicitud no válida' }, 400) }
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, { auth: { autoRefreshToken: false, persistSession: false } })
  if (typeof body.site === 'string') {
    if (!UUID.test(body.site)) return json({ success: false, error: 'Solicitud no válida' }, 400)
    const session = await createSessionClient()
    const { data: { user } } = await session.auth.getUser()
    if (!user) return json({ success: false, error: 'Inicie sesión para ver el documento' }, 401)
    const sites = await session.rpc('tracking_internal_sites')
    const allowed = (sites.data?.sites as Array<{ id: string }> | undefined)?.some(s => s.id === body.site)
    if (sites.error || !allowed) return json({ success: false, error: 'Sin acceso a esta sede' }, 403)
    const link = await admin.from('tracking_portal_internal').select('token, pin').eq('site_id', body.site).maybeSingle()
    if (link.error || !link.data) return json({ success: false, error: 'Abra de nuevo el seguimiento e inténtelo otra vez' }, 409)
    body = { ...body, token: link.data.token, pin: link.data.pin }
  }
  const { token, pin, kind, id } = body
  const requestId = body.request_id ?? null
  const index = body.index ?? 1
  if (typeof token !== 'string' || !UUID.test(token) || typeof pin !== 'string' || !/^([A-Za-z0-9]{4}|\d{8})$/.test(pin)
    || (kind !== 'DOC' && kind !== 'FIRMA' && kind !== 'PACKING') || typeof id !== 'string' || !UUID.test(id)
    || (requestId !== null && (typeof requestId !== 'string' || !UUID.test(requestId)))
    || typeof index !== 'number' || !Number.isInteger(index) || index < 1 || index > 5) {
    return json({ success: false, error: 'Solicitud no válida' }, 400)
  }
  const { data, error } = await admin.rpc('get_public_tracking_document', {
    p_token: token, p_pin: pin, p_kind: kind, p_id: id, p_request: requestId, p_index: index,
  })
  if (error) return json({ success: false, error: 'No se pudo consultar el documento' }, 503)
  if (!data || data.error) return json({ success: false, error: data?.error || 'Documento no disponible' }, 403)
  const signed = await admin.storage.from(data.bucket).createSignedUrl(data.path, 300)
  if (signed.error || !signed.data?.signedUrl) return json({ success: false, error: 'El archivo no está disponible' }, 404)
  return json({ success: true, url: signed.data.signedUrl, name: data.name })
}
