import { createClient as createAdminClient } from '@supabase/supabase-js'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { isSystemAdminRole } from '@/lib/roles'

export async function getSystemAdminContext() {
  const sessionClient = await createServerClient()
  const { data: { user } } = await sessionClient.auth.getUser()
  if (!user) return null

  const { data: profile } = await sessionClient
    .from('profiles')
    .select('is_active, roles(name)')
    .eq('id', user.id)
    .maybeSingle()
  const role = Array.isArray(profile?.roles) ? profile.roles[0] : profile?.roles
  if (!profile?.is_active || !isSystemAdminRole(role?.name)) return null

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!serviceRoleKey || !supabaseUrl) throw new Error('Configuración del servidor incompleta')

  const adminClient = createAdminClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  return { adminClient, user }
}
