import { createClient } from '@/lib/supabase/server'
import { isSystemAdminRole } from '@/lib/roles'

export async function getActiveSession() {
  const client = await createClient()
  const { data: { user } } = await client.auth.getUser()
  if (!user) return null
  const { data: profile } = await client.from('profiles').select('is_active, roles(name,permissions)').eq('id', user.id).maybeSingle()
  if (!profile?.is_active) return null
  const role = Array.isArray(profile.roles) ? profile.roles[0] : profile.roles
  const permissions: unknown = role?.permissions
  return {
    client,
    user,
    canRead(module: string) {
      return isSystemAdminRole(role?.name) || (Array.isArray(permissions) &&
        permissions.some(p => p === module || p === `${module}:read` || p === `${module}:write`))
    },
  }
}
