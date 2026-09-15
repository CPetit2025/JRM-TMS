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

    if (!dni || !firstName || !lastName || !pin || !carrierId || !licenseNumber) {
      return NextResponse.json({ error: 'Faltan campos obligatorios' }, { status: 400 })
    }

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

    if (rpcError) throw rpcError

    return NextResponse.json({ success: true, userId })

  } catch (err: any) {
    console.error('Register error:', err)
    return NextResponse.json({ error: err.message || 'Error al registrar' }, { status: 500 })
  }
}
