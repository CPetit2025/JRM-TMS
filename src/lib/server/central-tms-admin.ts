import 'server-only'
import { headers } from 'next/headers'
import { createClient } from '@supabase/supabase-js'
import { isSystemAdminRole } from '@/lib/roles'

// Central administration authenticates against TMS; a WMS administrator token is not sufficient.
export async function getSystemAdminContext() {
  const bearer = (await headers()).get('authorization')
  if (!bearer?.startsWith('Bearer ')) return null
  const url = process.env.TMS_SUPABASE_URL
  const key = process.env.TMS_SUPABASE_ANON_KEY
  if (!url || !key || new URL(url).origin !== 'https://eojfsbogysifxrlrnjvx.supabase.co') throw new Error('Autorización central TMS no configurada')
  const client = createClient(url, key, { global: { headers: { Authorization: bearer } }, auth: { persistSession: false, autoRefreshToken: false } })
  const { data: { user }, error } = await client.auth.getUser(bearer.slice(7))
  if (error || !user) return null
  const { data: profile, error: profileError } = await client.from('profiles').select('is_active, roles(name)').eq('id', user.id).maybeSingle()
  const role = Array.isArray(profile?.roles) ? profile.roles[0] : profile?.roles
  if (profileError || !profile?.is_active || !isSystemAdminRole(role?.name)) return null
  return { user, tmsClient: client }
}
