import { NextResponse } from 'next/server'
import { getSystemAdminContext } from '@/lib/server/system-admin'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

async function forward(request: Request) {
  try {
    if (!await getSystemAdminContext()) return NextResponse.json({ error: 'Solo el Administrador del Sistema puede administrar WMS' }, { status: 403 })
    if (request.method !== 'GET' && request.headers.get('origin') !== new URL(request.url).origin) return NextResponse.json({ error: 'Origen no autorizado' }, { status: 403 })
    // Pin the existing production origin. Never send a TMS token to a client-supplied destination.
    const client = await createClient()
    const { data: { session }, error } = await client.auth.getSession()
    if (error || !session) return NextResponse.json({ error: 'Sesión vencida' }, { status: 401 })
    const upstream = await fetch('https://wms.jrmlogistica.app/api/admin/wms', {
      method: request.method,
      headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      ...(request.method === 'POST' ? { body: JSON.stringify(await request.json()) } : {}),
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000),
    })
    if (!upstream.headers.get('content-type')?.includes('application/json')) throw new Error('Respuesta WMS no disponible')
    const body = await upstream.json()
    return NextResponse.json(body, { status: upstream.status, headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'No se pudo conectar con la administración WMS. No se confirmó el cambio; actualice el listado antes de reintentar.' }, { status: 503 })
  }
}
export const GET = forward
export const POST = forward
