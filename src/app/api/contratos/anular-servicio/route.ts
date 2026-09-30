import { NextResponse } from 'next/server'
import { createClient as createSessionClient } from '@/lib/supabase/server'
import { createClient } from '@supabase/supabase-js'

// Anulación de un gasto de OT (contract_services). Solo el Administrador o el Jefe de Distribución anulan.
// Otro usuario de Servicios de Contrato puede anular si uno de ellos lo autoriza con su credencial (correo y
// contraseña): se verifica contra Supabase Auth en el servidor, se anula con esa sesión y se cierra al terminar.
// La base registra quién pidió (void_requested_by) y quién autorizó (voided_by).

export const runtime = 'nodejs'

type Rpc = { data: unknown; error: { message: string } | null }

export async function POST(request: Request) {
  let body: { serviceId?: unknown; reason?: unknown; email?: unknown; password?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Solicitud inválida.' }, { status: 400 }) }
  const serviceId = typeof body.serviceId === 'string' && /^[0-9a-f-]{36}$/i.test(body.serviceId) ? body.serviceId : null
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : ''
  if (!serviceId) return NextResponse.json({ error: 'Gasto inválido.' }, { status: 400 })
  if (!reason) return NextResponse.json({ error: 'Indique el motivo de la anulación.' }, { status: 400 })

  const session = await createSessionClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Inicie sesión.' }, { status: 401 })

  const direct = await session.rpc('can_void_contract_service') as Rpc
  if (direct.data === true) return finish(await session.rpc('void_contract_service', { p_service_id: serviceId, p_reason: reason, p_requested_by: user.id }) as Rpc)

  // Quien pide debe trabajar en Servicios de Contrato
  const [svc, cli] = await Promise.all([
    session.rpc('has_tms_permission', { p_permission: 'contratos-servicios' }) as unknown as Promise<Rpc>,
    session.rpc('has_tms_permission', { p_permission: 'clientes' }) as unknown as Promise<Rpc>,
  ])
  if (svc.data !== true && cli.data !== true) return NextResponse.json({ error: 'Sin permiso para anular gastos de contrato.' }, { status: 403 })

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 200) : ''
  const password = typeof body.password === 'string' ? body.password.slice(0, 200) : ''
  if (!email || !password) {
    return NextResponse.json({ error: 'Se requiere la autorización del Administrador o del Jefe de Distribución.', needsAuthorization: true }, { status: 403 })
  }

  const authorizer = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
  const signIn = await authorizer.auth.signInWithPassword({ email, password })
  if (signIn.error || !signIn.data.session) {
    return NextResponse.json({ error: 'Credencial inválida.', needsAuthorization: true }, { status: 401 })
  }
  try {
    const allowed = await authorizer.rpc('can_void_contract_service') as Rpc
    if (allowed.data !== true) {
      return NextResponse.json({ error: 'La credencial no corresponde al Administrador ni al Jefe de Distribución.', needsAuthorization: true }, { status: 403 })
    }
    return finish(await authorizer.rpc('void_contract_service', { p_service_id: serviceId, p_reason: reason, p_requested_by: user.id }) as Rpc)
  } finally {
    // Cierra solo la sesión creada para esta autorización
    await authorizer.auth.signOut({ scope: 'local' }).catch(() => undefined)
  }
}

function finish(result: Rpc) {
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 400 })
  const data = result.data as { success?: boolean; error?: string } | null
  if (!data?.success) return NextResponse.json({ error: data?.error || 'No se pudo anular.' }, { status: 400 })
  return NextResponse.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } })
}
