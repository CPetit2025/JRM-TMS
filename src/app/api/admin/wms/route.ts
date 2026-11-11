import { NextResponse } from 'next/server'
import { getSystemAdminContext } from '@/lib/server/central-tms-admin'
import { getWmsAdminClient } from '@/lib/server/wms-admin'
import { isSystemAdminRole } from '@/lib/roles'
import { validateWmsAccount, validateWmsRole } from '@/lib/wms-administration'

export const dynamic = 'force-dynamic'
const fail = (error: unknown, status = 400) => NextResponse.json({ error: error instanceof Error ? error.message : 'No se pudo completar la operación WMS' }, { status, headers: { 'Cache-Control': 'no-store' } })

export async function GET() {
  try {
    if (!await getSystemAdminContext()) return fail(new Error('Solo el Administrador del Sistema puede administrar WMS'), 403)
    const client = getWmsAdminClient()
    const [users, roles] = await Promise.all([
      client.from('profiles').select('id, first_name, last_name, username, email, document_number, phone, role_id, is_active, roles(id, name, permissions)').order('created_at', { ascending: false }).limit(1000),
      client.from('roles').select('id, name, description, permissions').order('name'),
    ])
    if (users.error || roles.error) throw new Error('No se pudo consultar el directorio WMS')
    return NextResponse.json({ users: users.data, roles: roles.data, truncated: users.data.length === 1000 }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return fail(error, 503) }
}

export async function POST(request: Request) {
  try {
    if (!await getSystemAdminContext()) return fail(new Error('Solo el Administrador del Sistema puede administrar WMS'), 403)
    const body = await request.json()
    const client = getWmsAdminClient()
    if (body.action === 'role') {
      const values = validateWmsRole(body)
      if (isSystemAdminRole(values.name)) return fail(new Error('El administrador WMS se gestiona en su entorno de seguridad'))
      if (body.id) {
        const { data: before, error } = await client.from('roles').select('name, permissions').eq('id', body.id).single()
        if (error || !before || isSystemAdminRole(before.name) || !before.permissions?.some((p: string) => p.startsWith('almacen-'))) return fail(new Error('Solo se pueden editar roles operativos WMS'))
        // Existing role names may be referenced by database rules.
        values.name = before.name
      }
      const result = body.id ? await client.from('roles').update(values).eq('id', body.id) : await client.from('roles').insert(values)
      if (result.error) return fail(new Error('No se pudo guardar el rol WMS. Compruebe que el nombre no exista.'))
      return NextResponse.json({ success: true })
    }
    if (body.action !== 'user') return fail(new Error('Operación inválida'))
    const { email, password } = validateWmsAccount(body, !body.id)
    const { data: role, error: roleError } = await client.from('roles').select('name, permissions').eq('id', body.role_id).single()
    if (roleError || !role || isSystemAdminRole(role.name) || !role.permissions?.includes('almacen-lectura')) return fail(new Error('Seleccione un rol operativo WMS'))
    const changes = { first_name: body.first_name.trim(), last_name: body.last_name.trim(), username: email, email, document_number: body.document_number.trim(), phone: body.phone.trim(), role_id: body.role_id, is_active: body.is_active }
    if (body.id) {
      const { data: before, error } = await client.from('profiles').select('*, roles(name)').eq('id', body.id).single()
      if (error || !before || isSystemAdminRole(before.roles?.name)) return fail(new Error('Cuenta WMS no editable desde esta pantalla'))
      // Revoke first so a failure cannot leave a disabled user authorized.
      const { error: updateError } = await client.from('profiles').update(changes).eq('id', body.id)
      if (updateError) return fail(new Error('No se pudo guardar el perfil WMS'))
      const { error: authError } = email !== before.email || password
        ? await client.auth.admin.updateUserById(body.id, { email, email_confirm: true, ...(password ? { password } : {}) })
        : { error: null }
      if (authError) {
        await client.from('profiles').update(Object.fromEntries(Object.keys(changes).map(k => [k, k === 'is_active' && !body.is_active ? false : before[k]]))).eq('id', body.id)
        return fail(new Error(body.is_active ? 'No se pudo actualizar la cuenta WMS; vuelva a consultar su estado.' : 'Acceso WMS deshabilitado; no se pudo actualizar el correo o contraseña.'))
      }
    } else {
      // A duplicate email must never be silently linked or have its password replaced.
      const { data, error } = await client.auth.admin.createUser({ email, password: password!, email_confirm: true })
      if (error || !data.user) return fail(new Error('No se pudo crear la cuenta WMS. Si ya existe, edítela en el listado.'))
      const { error: profileError } = await client.from('profiles').upsert({ id: data.user.id, ...changes }, { onConflict: 'id' })
      if (profileError) {
        await client.auth.admin.deleteUser(data.user.id)
        return fail(new Error('No se pudo crear el perfil WMS'))
      }
    }
    return NextResponse.json({ success: true })
  } catch (error) { return fail(error) }
}
