import { createHmac } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

export async function reserveRegistration(request: Request, admin: SupabaseClient, scope: 'driver' | 'staff') {
  // Vercel overwrites this header; client-supplied X-Forwarded-For does not select the quota.
  const address = request.headers.get('x-vercel-forwarded-for')?.split(',')[0].trim() || 'unknown'
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) return 'unavailable'
  const fingerprint = createHmac('sha256', key).update(`registration:${scope}:${address}`).digest('hex')
  const { data, error } = await admin.rpc('reserve_registration_attempt', { p_scope: scope, p_fingerprint: fingerprint })
  if (error || typeof data !== 'boolean') return 'unavailable'
  return data ? 'allowed' : 'limited'
}
