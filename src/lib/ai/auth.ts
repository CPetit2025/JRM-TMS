import { createClient } from '@/lib/supabase/server'
import { isSystemAdminRole } from '@/lib/roles'

export async function getAiIdentity() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return null

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id, is_active, employee_type, roles(name, permissions)')
    .eq('id', user.id)
    .maybeSingle()
  if (profileError || !profile?.is_active) return null

  const role = Array.isArray(profile.roles) ? profile.roles[0] : profile.roles
  const permissions = Array.isArray(role?.permissions) ? role.permissions as string[] : []
  const isAdmin = isSystemAdminRole(role?.name)

  return {
    supabase,
    userId: user.id,
    employeeType: profile.employee_type as string | null,
    permissions,
    isAdmin,
    canRead(module: string) {
      return isAdmin || permissions.some(value => value === module || value === `${module}:read` || value === `${module}:write`)
    },
    canUseAi(scope: string, modules: string[]) {
      return isAdmin || (permissions.includes(`ia:read:${scope}`) && modules.some(module =>
        permissions.some(value => value === module || value === `${module}:read` || value === `${module}:write`)))
    },
    canPrepareMaintenance() {
      return isAdmin || (permissions.includes('ia:action:mantenimiento') &&
        (permissions.includes('mantenimiento-ot') || permissions.includes('mantenimiento-ot:write')))
    },
  }
}

export async function reserveAiRequest(
  supabase: NonNullable<Awaited<ReturnType<typeof getAiIdentity>>>['supabase'],
  scope: 'copilot' | 'ocr',
) {
  const { data, error } = await supabase.rpc('reserve_ai_request', { p_scope: scope })
  return !error && data === true
}
