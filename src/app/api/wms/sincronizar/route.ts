import { createClient } from '@/lib/supabase/server'
import { syncWithTms } from '@/lib/server/tms-sync'

export const dynamic = 'force-dynamic'

// Sincronización pedida por las pantallas del almacén. Corre con la sesión del usuario: la base WMS decide si toca
// (máximo una vez por minuto) y valida permisos. El cron del servidor hace lo mismo sin navegador (/api/wms/tms-cron).
export async function POST(request: Request) {
  const force = new URL(request.url).searchParams.get('forzar') === '1'
  const { status, body } = await syncWithTms(await createClient(), force)
  return Response.json(body, { status })
}
