import { createClient as createAdminClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Inventario multi-almacén: aplicar una carga y recalcular el modelo (FIFO, traspasos, origen) en el servidor.
// Desde el navegador cada consulta tiene 8 s; con un año de movimientos el recálculo tarda más. Aquí se verifica el
// permiso de carga del usuario (apt-carga, Administrador o Jefe de Distribución) y se ejecuta con la llave de servicio.
export const maxDuration = 180

type Paso = { error: { message: string } | null; data: ({ success?: boolean; error?: string } & Record<string, unknown>) | null }

export async function POST(request: Request) {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    return NextResponse.json({ success: false, error: 'Configuración del servidor incompleta', fallback: true }, { status: 503 })
  }
  let body: { accion?: string; upload_id?: string; force?: boolean }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Solicitud no válida' }, { status: 400 })
  }
  const accion = body.accion === 'aplicar' || body.accion === 'recalcular' ? body.accion : null
  if (!accion) return NextResponse.json({ success: false, error: 'Acción no válida' }, { status: 400 })
  if (accion === 'aplicar' && !/^[0-9a-f-]{36}$/i.test(body.upload_id || '')) {
    return NextResponse.json({ success: false, error: 'Carga no válida' }, { status: 400 })
  }

  const session = await createClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) return NextResponse.json({ success: false, error: 'Sesión no válida' }, { status: 401 })
  const perm = await session.rpc('inv_status')
  if (perm.error || !perm.data?.success || !perm.data.can_load) {
    return NextResponse.json({ success: false, error: 'No tiene permiso para cargar movimientos de inventario' }, { status: 403 })
  }

  const admin = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  if (accion === 'aplicar') {
    const applied = await admin.rpc('inv_upload_apply_core', { p_upload_id: body.upload_id, p_force: !!body.force }) as Paso
    if (applied.error) return NextResponse.json({ success: false, error: applied.error.message }, { status: 400 })
    if (!applied.data?.success) return NextResponse.json({ ...(applied.data || {}), success: false }, { status: 400 })
    return NextResponse.json(applied.data)
  }
  // Si ya hay un recálculo en curso no se espera (responde pendiente); después se dejan al día las vistas guardadas
  const model = await admin.rpc('inv_rebuild_request') as Paso
  if (model.error) return NextResponse.json({ success: false, error: `Recalcular el inventario: ${model.error.message}` }, { status: 500 })
  if (model.data?.success && !model.data.pending) {
    const cache = await admin.rpc('inv_cache_refresh') as Paso
    if (cache.error || !cache.data?.success) return NextResponse.json({ ...model.data, pending: true })
  }
  return NextResponse.json(model.data ?? { success: false, error: 'Sin respuesta' })
}
