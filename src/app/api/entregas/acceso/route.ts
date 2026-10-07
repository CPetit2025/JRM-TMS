import { createHmac } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) return NextResponse.json({ success: false, error: 'Portal temporalmente no disponible' }, { status: 503, headers })
  let body: { placa?: unknown; codigo?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Solicitud no válida' }, { status: 400, headers }) }
  if (typeof body.placa !== 'string' || typeof body.codigo !== 'string' || body.placa.length > 12 || body.codigo.length > 18) {
    return NextResponse.json({ success: false, error: 'Ingrese placa y código de acceso' }, { status: 400, headers })
  }
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, { auth: { autoRefreshToken: false, persistSession: false } })
  const fingerprint = createHmac('sha256', key).update('delivery-access:' + (request.headers.get('x-vercel-forwarded-for')?.split(',')[0].trim() || 'unknown')).digest('hex')
  const { data, error } = await admin.rpc('delivery_portal_login', { p_plate: body.placa, p_code: body.codigo, p_fingerprint: fingerprint })
  if (error) return NextResponse.json({ success: false, error: 'No se pudo verificar el acceso. Intente nuevamente.' }, { status: 503, headers })
  return NextResponse.json(data, { status: data?.limited ? 429 : data?.success ? 200 : 403, headers })
}
