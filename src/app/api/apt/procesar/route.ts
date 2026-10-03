import { createClient as createAdminClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Procesa una carga de APT en el servidor: aplicar el reemplazo por fechas, recalcular la estadía (FIFO) y el flujo
// multi-almacén. Desde el navegador cada paso tiene un límite de 8 s por consulta; con el reporte total del ERP
// (≈ 90 000 filas) se excedía. Aquí se verifica el permiso de carga del usuario y se ejecuta con la llave de servicio.
export const maxDuration = 60

type Paso = { error: { message: string } | null; data: { success?: boolean; error?: string } & Record<string, unknown> | null }

function fallo(p: Paso, etapa: string) {
  if (p.error) return `${etapa}: ${p.error.message}`
  if (!p.data || p.data.success === false) return `${etapa}: ${p.data?.error || 'sin respuesta'}`
  return null
}

export async function POST(request: Request) {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    return NextResponse.json({ success: false, error: 'Configuración del servidor incompleta', fallback: true }, { status: 503 })
  }
  let body: { accion?: string; upload_id?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Solicitud no válida' }, { status: 400 })
  }
  const accion = body.accion === 'recalcular' ? 'recalcular' : 'aplicar'
  if (accion === 'aplicar' && !/^[0-9a-f-]{36}$/i.test(body.upload_id || '')) {
    return NextResponse.json({ success: false, error: 'Carga no válida' }, { status: 400 })
  }

  // Permiso del usuario de la sesión (las mismas reglas que en la base: apt-carga, Administrador o Jefe de Distribución)
  const session = await createClient()
  const { data: { user } } = await session.auth.getUser()
  if (!user) return NextResponse.json({ success: false, error: 'Sesión no válida' }, { status: 401 })
  const perm = await session.rpc('apt_get_settings')
  if (perm.error || !perm.data?.success || !perm.data.can_load) {
    return NextResponse.json({ success: false, error: 'No tiene permiso para cargar movimientos de APT' }, { status: 403 })
  }

  const admin = createAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  let summary: unknown = null
  if (accion === 'aplicar') {
    const applied = await admin.rpc('apt_upload_apply_core', { p_upload_id: body.upload_id, p_rebuild: false }) as Paso
    const err = fallo(applied, 'Aplicar la carga')
    if (err) return NextResponse.json({ success: false, error: err }, { status: 400 })
    summary = applied.data?.summary ?? null
  }
  const model = await admin.rpc('apt_rebuild') as Paso
  const errModel = fallo(model, 'Recalcular la estadía')
  if (errModel) return NextResponse.json({ success: false, error: errModel, summary }, { status: 500 })
  const flow = await admin.rpc('apt_flow_rebuild_core') as Paso
  const errFlow = fallo(flow, 'Recalcular el flujo multi-almacén')
  if (errFlow) return NextResponse.json({ success: false, error: errFlow, summary, model: model.data }, { status: 500 })

  return NextResponse.json({ success: true, summary, model: model.data, flow: flow.data })
}
