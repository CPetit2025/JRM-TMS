import 'server-only'
import { randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isSystemAdminRole } from '@/lib/roles'

export async function provisionTmsUser(wms: SupabaseClient, tms: SupabaseClient, body: Record<string, unknown>) {
  if (typeof body.tms_profile_id !== 'string' || typeof body.role_id !== 'string' || typeof body.is_active !== 'boolean') throw new Error('Seleccione usuario TMS, rol y estado WMS')
  // Resolve identity in TMS on the server. Never trust names or email submitted by the browser.
  const { data: source, error: sourceError } = await tms.from('profiles')
    .select('id, first_name, last_name, username, document_number, phone')
    .eq('id', body.tms_profile_id).single()
  const email = (source?.username || '').trim().toLowerCase()
  if (sourceError || !source || !/^[^\s@]+@jrmsac\.com\.pe$/.test(email)) throw new Error('Usuario TMS no disponible o sin correo corporativo válido')
  const { data: role, error: roleError } = await wms.from('roles').select('name, permissions').eq('id', body.role_id).single()
  if (roleError || !role || isSystemAdminRole(role.name) || !role.permissions?.includes('almacen-lectura')) throw new Error('Seleccione un rol operativo WMS')
  const { data: existing, error: lookupError } = await wms.from('profiles').select('id, roles(name)').eq('email', email).maybeSingle()
  if (lookupError) throw new Error('No se pudo comprobar si el usuario ya tiene WMS')
  if (existing && isSystemAdminRole((Array.isArray(existing.roles) ? existing.roles[0] : existing.roles)?.name)) throw new Error('La cuenta WMS es un administrador protegido')
  let userId: string
  let created = false
  if (existing) {
    const { data, error } = await wms.auth.admin.getUserById(existing.id)
    const linked = data?.user?.app_metadata?.tms_profile_id
    if (error || data.user?.email?.toLowerCase() !== email || (linked && linked !== source.id)) throw new Error('La cuenta WMS existente no corresponde a este usuario TMS')
    userId = existing.id
  } else {
    const { data, error } = await wms.auth.admin.createUser({
      email, password: randomBytes(32).toString('base64url'), email_confirm: true,
      app_metadata: { tms_profile_id: source.id },
    })
    if (error || !data.user) throw new Error('No se pudo crear el acceso WMS. Si el correo ya existe, revise su cuenta WMS antes de reintentar.')
    userId = data.user.id
    created = true
  }
  const { error: profileError } = await wms.from('profiles').upsert({
    id: userId, email, username: email, first_name: source.first_name, last_name: source.last_name,
    document_number: source.document_number, phone: source.phone,
    role_id: body.role_id, is_active: body.is_active,
  }, { onConflict: 'id' })
  if (profileError) {
    if (created) await wms.auth.admin.deleteUser(userId)
    throw new Error('No se pudo guardar el acceso WMS')
  }
  let firstAccessUrl: string | null = null
  if (created) {
    const { data, error } = await wms.auth.admin.generateLink({ type: 'recovery', email })
    if (!error && data.properties?.hashed_token) {
      const link = new URL('https://wms.jrmlogistica.app/login/restablecer')
      link.searchParams.set('token_hash', data.properties.hashed_token)
      firstAccessUrl = link.toString()
    }
  }
  return {
    success: true, created, firstAccessUrl, firstAccessRecipient: email,
    message: created
      ? firstAccessUrl ? 'Acceso WMS guardado. Comparta el enlace de primer acceso para que el usuario configure su contraseña WMS.' : 'Acceso WMS guardado. El usuario debe configurar su contraseña desde «¿Olvidaste tu contraseña?» en WMS.'
      : 'Acceso WMS actualizado. Se conservó su contraseña WMS. El acceso TMS no cambió.',
  }
}
