import { reserveRegistration } from '@/lib/server/registration-limit'
import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { isSystemAdminRole } from '@/lib/roles'
import { isRequestArea } from '@/lib/request-areas'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { first_name, last_name, username, document_number, phone, role_id, password, area } = body

    if (typeof username !== 'string' || typeof password !== 'string' || password.length < 8 || password.length > 200 || typeof document_number !== 'string' || !document_number || document_number.length > 20 || [first_name, last_name, phone].some(value => value != null && (typeof value !== 'string' || value.length > 120))) {
      return NextResponse.json(
        { error: 'Usuario, documento y contraseña de al menos 8 caracteres son obligatorios' },
        { status: 400 }
      )
    }

    if (area != null && area !== '' && !isRequestArea(area)) {
      return NextResponse.json({ error: 'Área inválida' }, { status: 400 })
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
      isAdmin = isSystemAdminRole(role?.name)
      if (!isAdmin) {
        return NextResponse.json({ error: 'Solo un administrador puede crear usuarios' }, { status: 403 })
      }
    }
    // El registro público declara su área: se muestra al aprobar y completa sus solicitudes
    if (!isAdmin && !isRequestArea(area)) {
      return NextResponse.json({ error: 'Seleccione su área' }, { status: 400 })
    }
    if (!isAdmin) {
      const quota = await reserveRegistration(request, supabaseAdmin, 'staff')
      if (quota !== 'allowed') return NextResponse.json({ error: quota === 'limited' ? 'Demasiados intentos. Intente nuevamente en 15 minutos.' : 'Registro temporalmente no disponible' }, { status: quota === 'limited' ? 429 : 503 })
    }
    if (isAdmin && role_id) {
      if (typeof role_id !== 'string') return NextResponse.json({ error: 'Rol inválido' }, { status: 400 })
      const { data: role } = await supabaseAdmin.from('roles').select('id').eq('id', role_id).maybeSingle()
      if (!role) return NextResponse.json({ error: 'Rol inválido' }, { status: 400 })
    }
    const is_active = isAdmin

    const metadata = { first_name, last_name, document_number, role_id: isAdmin ? role_id : null }
    // 1. Crear el usuario en auth.users. El registro público confirma el correo (signUp envía el enlace): nadie
    //    registra un correo corporativo que no es suyo. Errores genéricos para no revelar qué correos existen.
    let userId: string
    if (isAdmin) {
      const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: metadata
      })
      if (authError) {
        console.error('Error creating auth user:', authError)
        return NextResponse.json({ error: authError.message }, { status: 400 })
      }
      userId = authData.user.id
    } else {
      const publicClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
      })
      const { data: signUp, error: signUpError } = await publicClient.auth.signUp({
        email, password, options: { data: metadata, emailRedirectTo: `${new URL(request.url).origin}/login` }
      })
      if (signUpError || !signUp.user) {
        console.error('Error in public sign up:', signUpError)
        return NextResponse.json({ error: 'No se pudo completar el registro. Si ya tiene cuenta, recupere su contraseña.' }, { status: 400 })
      }
      // Correo ya registrado: Supabase devuelve un usuario sin identidades; se responde igual que un registro nuevo
      if (!signUp.user.identities?.length) return NextResponse.json({ success: true, pending: true })
      userId = signUp.user.id
    }

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
          area: isRequestArea(area) ? area : null,
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
  } catch (error) {
    console.error('API Error:', error)
    return NextResponse.json({ error: 'Error interno del servidor' }, { status: 500 })
  }
}
