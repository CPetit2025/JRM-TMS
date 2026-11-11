import 'server-only'
import { createClient } from '@supabase/supabase-js'

export function getWmsAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  // Central administration is only enabled for the verified WMS production database.
  if (!url || new URL(url).origin !== 'https://glecgvomkaqmkfkhtxhi.supabase.co' || !key) throw new Error('Destino de administración WMS inválido')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}
