import { createClient as createAdminClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Datos del ERP: aplicar una carga (Actualizable o Stock) en el servidor. Desde el navegador cada consulta tiene 8 s y
// el Actualizable completo (70 mil líneas, cruce de guías y pesos) puede tardar más. Se verifica el permiso de carga del
// usuario y se ejecuta con la llave de servicio.
export const maxDuration = 120

type Paso = { error: { message: string } | null; data: ({ success?: boolean; error?: string } & Record<string, unknown>) | null }

export async function POST(request: Request) {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    return NextResponse.json({ success: false, error: 'Configuración del servidor incompleta', fallback: true }, { status: 503 })
  }
  let body: { upload_id?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Solicitud no válida' }, { status: 400 })
  }
  if (!/^[0-9a-f-]{36}$/i.test(body.upload_id || '')) return NextResponse.json({ success: false, error: 'Carga no válida' }, { status: 400 })

  const session = await createClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) return NextResponse.json({ success: false, error: 'Sesión no válida' }, { status: 401 })
  const perm = await session.rpc('erp_estado')
  if (perm.error || !perm.data?.success || !perm.data.can_load) {
    return NextResponse.json({ success: false, error: 'No tiene permiso para cargar datos del ERP' }, { status: 403 })
  }

  const admin = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const applied = await admin.rpc('erp_upload_apply_core', { p_upload_id: body.upload_id }) as Paso
  if (applied.error) return NextResponse.json({ success: false, error: applied.error.message }, { status: 400 })
  if (!applied.data?.success) return NextResponse.json({ ...(applied.data || {}), success: false }, { status: 400 })
  return NextResponse.json(applied.data)
}
