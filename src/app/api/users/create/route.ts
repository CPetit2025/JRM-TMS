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

    // Verificar si la petición viene de un usuario autenticado (Admin)
    const { cookies } = await import('next/headers')
    const { createServerClient } = await import('@supabase/ssr')
    const cookieStore = cookies()
    
    const supabaseSession = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll() {}
        },
      }
    )
    
    const { data: { user: currentUser } } = await supabaseSession.auth.getUser()
    
    // Si hay un admin logueado, se crea activo. Si es registro público, inactivo.
    const is_active = currentUser ? true : false;

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
          is_active: is_active
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
