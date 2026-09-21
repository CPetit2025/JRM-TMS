import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { isSystemAdminRole } from '@/lib/roles'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { first_name, last_name, username, document_number, phone, role_id, password } = body

    if (!username || !password || password.length < 8 || !document_number) {
      return NextResponse.json(
        { error: 'Usuario, documento y contraseña de al menos 8 caracteres son obligatorios' },
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

    // El "username" que viene del front ahora es el correo completo
    const email = username.toLowerCase().trim()
    
    if (!email.endsWith('@jrmsac.com.pe')) {
      return NextResponse.json({ error: 'Solo se permiten correos corporativos (@jrmsac.com.pe)' }, { status: 400 })
    }

    // Verificar si la petición viene de un usuario autenticado (Admin)
    const { cookies } = await import('next/headers')
    const { createServerClient } = await import('@supabase/ssr')
    const cookieStore = await cookies()
    
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
    let isAdmin = false
    if (currentUser) {
      const { data: currentProfile, error: profileLookupError } = await supabaseSession
        .from('profiles')
        .select('is_active, roles(name, permissions)')
        .eq('id', currentUser.id)
        .single()
      if (profileLookupError || !currentProfile?.is_active) {
        return NextResponse.json({ error: 'Cuenta sin autorización' }, { status: 403 })
      }
      const role = Array.isArray(currentProfile.roles) ? currentProfile.roles[0] : currentProfile.roles
      const permissions = role?.permissions
      isAdmin = isSystemAdminRole(role?.name) ||
        (Array.isArray(permissions) && permissions.includes('usuarios'))
      if (!isAdmin) {
        return NextResponse.json({ error: 'Solo un administrador puede crear usuarios' }, { status: 403 })
      }
    }
    const is_active = isAdmin

    // 1. Crear el usuario en auth.users
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true,
      user_metadata: {
        first_name,
        last_name,
        document_number,
        role_id: isAdmin ? role_id : null
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
      .upsert([
        {
          id: userId,
          first_name,
          last_name,
          username,
          document_number,
          phone,
          role_id: isAdmin ? role_id : null,
          is_active: is_active
        }
      ], { onConflict: 'id' })

    if (profileError) {
      console.error('Error creating profile:', profileError)
      await supabaseAdmin.auth.admin.deleteUser(userId)
      return NextResponse.json({ error: profileError.message }, { status: 400 })
    }

    return NextResponse.json({ success: true, userId })
  } catch (error: any) {
    console.error('API Error:', error)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
