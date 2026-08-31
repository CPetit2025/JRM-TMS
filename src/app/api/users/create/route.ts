import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { first_name, last_name, username, document_number, phone, role_id, password } = body

    if (!username || !password || !document_number) {
      return NextResponse.json(
        { error: 'Usuario, contraseña y documento son obligatorios' },
        { status: 400 }
      )
    }

    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!serviceRoleKey) {
      return NextResponse.json(
        { error: 'Configuración del servidor incompleta (falta SUPABASE_SERVICE_ROLE_KEY)' },
        { status: 500 }
      )
    }

    // Usar Service Role Key para poder crear usuarios sin estar logueados como ellos
    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      serviceRoleKey,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false
        }
      }
    )

    const email = `${username.toLowerCase().trim()}@jrm.com`

    // 1. Crear el usuario en auth.users
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true,
      user_metadata: {
        first_name,
        last_name,
        document_number,
        role_id
      }
    })

    if (authError) {
      console.error('Error creating auth user:', authError)
      return NextResponse.json({ error: authError.message }, { status: 400 })
    }

    const userId = authData.user.id

    // 2. Insertar en profiles
    const { error: profileError } = await supabaseAdmin
      .from('profiles')
      .insert([
        {
          id: userId,
          first_name,
          last_name,
          username,
          document_number,
          phone,
          role_id,
          mock_password: password, // Solo para MVP, normalmente no se guarda
          is_active: true
        }
      ])

    if (profileError) {
      console.error('Error creating profile:', profileError)
      // Idealmente, deberíamos revertir el auth.user aquí, pero para MVP está bien
      return NextResponse.json({ error: profileError.message }, { status: 400 })
    }

    return NextResponse.json({ success: true, userId })
  } catch (error: any) {
    console.error('API Error:', error)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
