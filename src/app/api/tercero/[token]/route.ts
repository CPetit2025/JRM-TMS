import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

// Enlace del chofer de un transportista tercero (/tracking/entrega/[token]): no tiene cuenta ni app. El servidor
// valida el enlace en la base (tercero_enlace_*, solo para la llave de servicio), sube la foto de la entrega a la
// carpeta del despacho y registra la salida o la entrega. El navegador nunca recibe la llave ni los costos del viaje.
export const maxDuration = 30

const MAX_FOTO = 10 * 1024 * 1024
const TIPOS = new Set(['image/jpeg', 'image/png', 'image/webp'])
type Rpc = { success?: boolean; error?: string; dispatch_id?: string } & Record<string, unknown>

function admin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) return null
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

const tokenValido = (t: string) => /^[a-f0-9]{64}$/.test(t)
const json = (body: Rpc, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const supabase = admin()
  if (!supabase) return json({ success: false, error: 'Configuración del servidor incompleta' }, 503)
  if (!tokenValido(token)) return json({ success: false, error: 'Enlace no válido' }, 404)
  const { data, error } = await supabase.rpc('tercero_enlace_info', { p_token: token })
  if (error) return json({ success: false, error: error.message }, 500)
  const r = data as Rpc
  // El id interno del despacho no se expone
  const { dispatch_id: _omit, ...rest } = r  // eslint-disable-line @typescript-eslint/no-unused-vars
  return json(rest, r.success ? 200 : 404)
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const supabase = admin()
  if (!supabase) return json({ success: false, error: 'Configuración del servidor incompleta' }, 503)
  if (!tokenValido(token)) return json({ success: false, error: 'Enlace no válido' }, 404)

  let form: FormData
  try { form = await request.formData() } catch { return json({ success: false, error: 'Solicitud no válida' }, 400) }
  const accion = String(form.get('accion') || '')

  if (accion === 'salida') {
    const { data, error } = await supabase.rpc('tercero_enlace_salida', { p_token: token })
    if (error) return json({ success: false, error: error.message }, 400)
    return json(data as Rpc)
  }

  if (accion === 'entrega') {
    const requestId = String(form.get('request_id') || '')
    const foto = form.get('foto')
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) return json({ success: false, error: 'Parada no válida' }, 400)
    if (!(foto instanceof File) || foto.size === 0) return json({ success: false, error: 'Tome la foto de la guía firmada' }, 400)
    if (!TIPOS.has(foto.type) || foto.size > MAX_FOTO) return json({ success: false, error: 'La foto debe ser JPG, PNG o WEBP de hasta 10 MB' }, 400)

    // El enlace se valida antes de subir nada: así se conoce la carpeta del despacho
    const { data: info, error: infoError } = await supabase.rpc('tercero_enlace_info', { p_token: token })
    const i = info as Rpc | null
    if (infoError || !i?.success || !i.dispatch_id) return json({ success: false, error: infoError?.message || i?.error || 'Enlace no válido' }, 404)

    const ext = foto.type === 'image/png' ? 'png' : foto.type === 'image/webp' ? 'webp' : 'jpg'
    const path = `tercero/${i.dispatch_id}/${crypto.randomUUID()}.${ext}`
    const { error: upError } = await supabase.storage.from('driver_evidence').upload(path, foto, { contentType: foto.type })
    if (upError) return json({ success: false, error: 'No se pudo subir la foto: ' + upError.message }, 500)

    const { data, error } = await supabase.rpc('tercero_enlace_entregar', {
      p_token: token, p_request_id: requestId,
      p_recibido_por: String(form.get('recibido_por') || '').slice(0, 120),
      p_foto: path, p_nota: String(form.get('nota') || '').slice(0, 200) || null,
    })
    const r = data as Rpc | null
    if (error || !r?.success) {
      await supabase.storage.from('driver_evidence').remove([path])
      return json({ success: false, error: error?.message || r?.error || 'No se pudo registrar la entrega' }, 400)
    }
    return json(r)
  }

  return json({ success: false, error: 'Acción no válida' }, 400)
}
