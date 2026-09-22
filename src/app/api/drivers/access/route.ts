import { NextResponse } from 'next/server'
import { getSystemAdminContext } from '@/lib/server/system-admin'

type DriverAccessBody = { driverId?: string; password?: string }

export async function POST(request: Request) {
  try {
    const context = await getSystemAdminContext()
    if (!context) return NextResponse.json({ error: 'Solo el Administrador del Sistema puede gestionar accesos' }, { status: 403 })

    const body = await request.json() as DriverAccessBody
    const driverId = body.driverId?.trim()
    const password = body.password?.trim()
    if (!driverId || !password || password.length < 8) {
      return NextResponse.json({ error: 'La contraseña debe tener al menos 8 caracteres' }, { status: 400 })
    }

    const { adminClient } = context
    const { data: driver, error: driverError } = await adminClient
      .from('drivers')
      .select('id, profile_id, document_number, first_name, last_name, phone')
      .eq('id', driverId)
      .maybeSingle()
    if (driverError || !driver) return NextResponse.json({ error: 'Conductor no encontrado' }, { status: 404 })

    const { data: conductorRole, error: roleError } = await adminClient
      .from('roles').select('id').eq('name', 'Conductor').maybeSingle()
    if (roleError || !conductorRole) return NextResponse.json({ error: 'El rol Conductor no está configurado' }, { status: 500 })

    const email = `${driver.document_number}@jrm.com`.toLowerCase()
    let profileId = driver.profile_id as string | null
    let createdAuthUser = false

    if (!profileId) {
      const { data: existingProfile } = await adminClient
        .from('profiles')
        .select('id, employee_type')
        .eq('document_number', driver.document_number)
        .maybeSingle()
      if (existingProfile?.id) {
        if (existingProfile.employee_type && existingProfile.employee_type !== 'CONDUCTOR') {
          return NextResponse.json({ error: 'El documento pertenece a un usuario administrativo' }, { status: 409 })
        }
        profileId = existingProfile.id
      }
    }

    if (profileId) {
      const { data: authRecord, error: authLookupError } = await adminClient.auth.admin.getUserById(profileId)
      if (authLookupError || !authRecord.user) return NextResponse.json({ error: 'La cuenta de autenticación vinculada no existe' }, { status: 409 })
      const { error: updateAuthError } = await adminClient.auth.admin.updateUserById(profileId, {
        email,
        email_confirm: true,
        password,
        user_metadata: {
          ...authRecord.user.user_metadata,
          first_name: driver.first_name,
          last_name: driver.last_name,
          document_number: driver.document_number,
          role_id: conductorRole.id,
        },
      })
      if (updateAuthError) return NextResponse.json({ error: updateAuthError.message }, { status: 400 })
    } else {
      const { data: created, error: createError } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          first_name: driver.first_name,
          last_name: driver.last_name,
          document_number: driver.document_number,
          role_id: conductorRole.id,
        },
      })
      if (createError || !created.user) return NextResponse.json({ error: createError?.message || 'No se pudo crear la cuenta' }, { status: 400 })
      profileId = created.user.id
      createdAuthUser = true
    }

    const { error: profileError } = await adminClient.from('profiles').upsert({
      id: profileId,
      username: email,
      first_name: driver.first_name,
      last_name: driver.last_name,
      document_number: driver.document_number,
      phone: driver.phone,
      employee_type: 'CONDUCTOR',
      role_id: conductorRole.id,
      is_active: true,
    }, { onConflict: 'id' })
    if (profileError) {
      if (createdAuthUser) await adminClient.auth.admin.deleteUser(profileId)
      return NextResponse.json({ error: profileError.message }, { status: 400 })
    }

    const { error: linkError } = await adminClient.from('drivers').update({
      profile_id: profileId,
      is_active: true,
      pin: null,
    }).eq('id', driver.id)
    if (linkError) {
      if (createdAuthUser) await adminClient.auth.admin.deleteUser(profileId)
      return NextResponse.json({ error: linkError.message }, { status: 400 })
    }

    return NextResponse.json({ success: true, username: email })
  } catch (error) {
    console.error('Driver access error:', error)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
