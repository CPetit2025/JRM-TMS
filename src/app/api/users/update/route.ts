import { NextResponse } from 'next/server'
import { getSystemAdminContext } from '@/lib/server/system-admin'

type UpdateUserBody = {
  id?: string
  first_name?: string
  last_name?: string
  username?: string
  document_number?: string
  phone?: string
  role_id?: string
  password?: string
}

export async function POST(request: Request) {
  try {
    const context = await getSystemAdminContext()
    if (!context) return NextResponse.json({ error: 'Solo el Administrador del Sistema puede editar usuarios' }, { status: 403 })

    const body = await request.json() as UpdateUserBody
    const id = body.id?.trim()
    const email = body.username?.trim().toLowerCase()
    const documentNumber = body.document_number?.trim()
    const password = body.password?.trim()
    if (!id || !email || !documentNumber || !body.role_id) {
      return NextResponse.json({ error: 'Usuario, documento y rol son obligatorios' }, { status: 400 })
    }
    if (password && password.length < 8) {
      return NextResponse.json({ error: 'La contraseña debe tener al menos 8 caracteres' }, { status: 400 })
    }

    const { adminClient } = context
    const { data: role, error: roleError } = await adminClient
      .from('roles').select('name').eq('id', body.role_id).maybeSingle()
    if (roleError || !role) return NextResponse.json({ error: 'Rol inválido' }, { status: 400 })

    const isDriver = role.name === 'Conductor'
    if ((!isDriver && !email.endsWith('@jrmsac.com.pe')) ||
        (isDriver && !email.endsWith('@jrm.com') && !email.endsWith('@jrmsac.com.pe'))) {
      return NextResponse.json({ error: isDriver ? 'La cuenta del conductor debe usar un correo JRM válido' : 'Se requiere correo corporativo @jrmsac.com.pe' }, { status: 400 })
    }

    const { data: driver } = await adminClient.from('drivers').select('id').eq('profile_id', id).maybeSingle()
    if (driver && !isDriver) {
      return NextResponse.json({ error: 'Un perfil vinculado a un conductor debe conservar el rol Conductor' }, { status: 400 })
    }

    const { data: authRecord, error: authLookupError } = await adminClient.auth.admin.getUserById(id)
    if (authLookupError || !authRecord.user) {
      return NextResponse.json({ error: 'No se encontró la cuenta de autenticación' }, { status: 404 })
    }

    const authChanges: Parameters<typeof adminClient.auth.admin.updateUserById>[1] = {
      email,
      email_confirm: true,
      user_metadata: {
        ...authRecord.user.user_metadata,
        first_name: body.first_name?.trim() || '',
        last_name: body.last_name?.trim() || '',
        document_number: documentNumber,
        role_id: body.role_id,
      },
    }
    if (password) authChanges.password = password
    const { error: authError } = await adminClient.auth.admin.updateUserById(id, authChanges)
    if (authError) return NextResponse.json({ error: authError.message }, { status: 400 })

    const profileChanges: Record<string, unknown> = {
      first_name: body.first_name?.trim() || '',
      last_name: body.last_name?.trim() || '',
      username: email,
      document_number: documentNumber,
      phone: body.phone?.trim() || null,
      role_id: body.role_id,
    }
    if (isDriver) profileChanges.employee_type = 'CONDUCTOR'
    const { data: profile, error: profileError } = await adminClient
      .from('profiles').update(profileChanges).eq('id', id).select().single()
    if (profileError) return NextResponse.json({ error: profileError.message }, { status: 400 })

    return NextResponse.json({ success: true, profile })
  } catch (error) {
    console.error('Update user error:', error)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
