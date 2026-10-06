import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import sharp from 'sharp'

export const maxDuration = 30
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
function admin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  return key ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, { auth: { autoRefreshToken: false, persistSession: false } }) : null
}
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const db = admin()
  if (!db) return json({ success: false, error: 'Portal temporalmente no disponible' }, 503)
  if (!/^[a-f0-9]{64}$/.test(token)) return json({ success: false, error: 'Enlace no válido' }, 404)
  const { data, error } = await db.rpc('tercero_enlace_info', { p_token: token })
  if (error) return json({ success: false, error: 'No se pudo consultar el servicio' }, 503)
  const { dispatch_id: _internal, ...result } = data // eslint-disable-line @typescript-eslint/no-unused-vars
  return json(result, result.success ? 200 : 403)
}
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const db = admin()
  if (!db) return json({ success: false, error: 'Portal temporalmente no disponible' }, 503)
  if (!/^[a-f0-9]{64}$/.test(token)) return json({ success: false, error: 'Enlace no válido' }, 404)
  if (Number(request.headers.get('content-length') || 0) > 4.5 * 1024 * 1024) return json({ success: false, error: 'Las fotos deben sumar menos de 4 MB' }, 413)
  let form: FormData
  try { form = await request.formData() } catch { return json({ success: false, error: 'Solicitud no válida' }, 400) }
  const action = String(form.get('accion') || '')
  if (action !== 'entrega') return json({ success: false, error: 'Este enlace permite únicamente subir la guía de remisión firmada en destino. Transporte de JRM registra la salida y llegada.' }, 400)
  const id = String(form.get('request_id') || '')
  if (!UUID.test(id)) return json({ success: false, error: 'Entrega no válida' }, 400)
  // Clientes anteriores no enviaban operation_id; se mantienen compatibles.
  const operation = String(form.get('operation_id') || crypto.randomUUID())
  if (!UUID.test(operation)) return json({ success: false, error: 'Operación no válida' }, 400)
  const access = await db.rpc('delivery_public_authorize', { p_token: token, p_request: id, p_operation: operation })
  if (access.error || !access.data?.success) return json({ success: false, error: access.error?.message || 'Entrega no autorizada' }, 403)
  if (access.data.duplicate) return json({ success: true, pending_review: true, duplicate: true, submission_id: access.data.submission_id })
  const photos = form.getAll('foto')
  if (!photos.length || photos.length > 5 || photos.some(photo => !(photo instanceof File) || photo.size === 0 || !TYPES.has(photo.type))) return json({ success: false, error: 'Adjunte de una a cinco fotos JPG, PNG o WEBP de la guía firmada' }, 400)
  const files = photos as File[]
  if (files.reduce((sum, photo) => sum + photo.size, 0) > 4 * 1024 * 1024) return json({ success: false, error: 'Las fotos deben sumar menos de 4 MB' }, 413)
  const receiver = String(form.get('recibido_por') || '').trim().slice(0, 120)
  if (!receiver) return json({ success: false, error: 'Indique quién recibió la entrega' }, 400)
  let buffers: Buffer[]
  try {
    // Decodifica la imagen, limita píxeles y elimina metadatos privados.
    buffers = await Promise.all(files.map(async file => sharp(Buffer.from(await file.arrayBuffer()), { limitInputPixels: 24_000_000, animated: false }).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()))
  } catch { return json({ success: false, error: 'Una foto no es una imagen válida. Adjunte JPG, PNG o WEBP.' }, 400) }
  const paths: string[] = []
  for (let index = 0; index < buffers.length; index++) {
    const path = `tercero/${access.data.dispatch_id}/${operation}-${index}.jpg`
    const { error } = await db.storage.from('driver_evidence').upload(path, buffers[index], { contentType: 'image/jpeg', upsert: false })
    if (error && String(error.statusCode) !== '409') return json({ success: false, error: 'No se pudo subir la foto. Reintente el envío.' }, 503)
    paths.push(path)
  }
  const { data, error } = await db.rpc('delivery_public_submit', { p_token: token, p_request: id, p_operation: operation, p_photos: paths, p_received: receiver, p_note: String(form.get('nota') || '').slice(0, 1000), p_guide: String(form.get('guia') || '').slice(0, 80) })
  // No se borran fotos ante un fallo de red: la transacción podría haberse confirmado.
  if (error) {
    const receipt = await db.rpc('delivery_public_authorize', { p_token: token, p_request: id, p_operation: operation })
    if (!receipt.error && receipt.data?.duplicate) return json({ success: true, pending_review: true, duplicate: true, submission_id: receipt.data.submission_id })
    return json({ success: false, error: error.message || 'No se pudo confirmar el envío. Reintente.' }, 400)
  }
  return json(data)
}
