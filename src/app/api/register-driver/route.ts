import { reserveRegistration } from '@/lib/server/registration-limit'
import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

// Admin client uses service_role key - bypasses email confirmation
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
)

export async function POST(request: Request) {
  try {
    const { dni, firstName, lastName, phone, licenseNumber, pin, carrierId } = await request.json()

    if (!dni || !firstName || !lastName || !pin || pin.length < 8 || !carrierId || !licenseNumber) {
      return NextResponse.json({ error: 'Faltan campos obligatorios' }, { status: 400 })
    }

    if (typeof dni !== 'string' || !/^\d{8}$/.test(dni) ||
        [firstName, lastName, licenseNumber, pin, carrierId].some(value => typeof value !== 'string' || value.length > 200) ||
        !/^[0-9a-f-]{36}$/i.test(carrierId) || (phone != null && (typeof phone !== 'string' || phone.length > 30))) {
      return NextResponse.json({ error: 'Datos de registro inválidos' }, { status: 400 })
    }
    const quota = await reserveRegistration(request, supabaseAdmin, 'driver')
    if (quota !== 'allowed') return NextResponse.json({ error: quota === 'limited' ? 'Demasiados intentos. Intente nuevamente en 15 minutos.' : 'Registro temporalmente no disponible' }, { status: quota === 'limited' ? 429 : 503 })
    const { data: carrier } = await supabaseAdmin.from('carriers').select('id').eq('id', carrierId).eq('is_active', true).maybeSingle()
    if (!carrier) return NextResponse.json({ error: 'Transportista no disponible' }, { status: 400 })
    const email = `${dni}@jrm.com`

    // 1. Create auth user WITHOUT email confirmation (admin API)
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: pin,
      email_confirm: true, // skip confirmation
      user_metadata: {
        first_name: firstName,
        last_name: lastName,
        document_id: dni
      }
    })

    if (authError) {
      if (authError.message.includes('already been registered') || authError.message.includes('already exists')) {
        return NextResponse.json({ error: 'El DNI ya se encuentra registrado' }, { status: 409 })
      }
      throw authError
    }

    const userId = authData.user.id

    const { data: conductorRole, error: roleError } = await supabaseAdmin
      .from('roles')
      .select('id')
      .eq('name', 'Conductor')
      .maybeSingle()
    if (roleError || !conductorRole) {
      await supabaseAdmin.auth.admin.deleteUser(userId)
      return NextResponse.json({ error: 'El rol Conductor no está configurado' }, { status: 500 })
    }

    const { error: profileError } = await supabaseAdmin.from('profiles').upsert({
      id: userId,
      username: email,
      first_name: firstName,
      last_name: lastName,
      document_number: dni,
      phone: phone || null,
      employee_type: 'CONDUCTOR',
      is_active: false,
      role_id: conductorRole.id
    }, { onConflict: 'id' })
    if (profileError) {
      await supabaseAdmin.auth.admin.deleteUser(userId)
      throw profileError
    }

    // 2. Use RPC function to upsert driver - bypasses PostgREST schema cache issues
    const { error: rpcError } = await supabaseAdmin.rpc('register_driver', {
      p_auth_user_id: userId,
      p_dni: dni,
      p_first_name: firstName,
      p_last_name: lastName,
      p_phone: phone || '',
      p_license_number: licenseNumber,
      p_pin: pin,
      p_carrier_id: carrierId
    })

    if (rpcError) {
      await supabaseAdmin.auth.admin.deleteUser(userId)
      throw rpcError
    }

    return NextResponse.json({ success: true, userId })

  } catch (err: unknown) {
    console.error('Register error:', err)
    return NextResponse.json({ error: 'No se pudo completar el registro' }, { status: 500 })
  }
}
