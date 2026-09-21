import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { isSystemAdminRole } from '@/lib/roles'

export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({
            request,
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // refreshes the auth token and gets the user
  const { data: { user } } = await supabase.auth.getUser()

  const isLoginPage = request.nextUrl.pathname.startsWith('/login')
  const isDriverLoginPage = request.nextUrl.pathname.startsWith('/app/login')
  const isDriverRegisterPage = request.nextUrl.pathname.startsWith('/app/register')
  const isDriverRoute = request.nextUrl.pathname.startsWith('/app')
  const isApiRoute = request.nextUrl.pathname.startsWith('/api')
  const isPublicTracking = request.nextUrl.pathname.startsWith('/tracking/')
  let hasDashboardAccess = false
  
  // Si no está autenticado y NO está en una página de login ni API
  if (!user && !isLoginPage && !isDriverLoginPage && !isDriverRegisterPage && !isApiRoute && !isPublicTracking) {
    // Si intenta ir a la app operativa, mandarlo a su login
    if (isDriverRoute) {
      const url = request.nextUrl.clone()
      url.pathname = '/app/login'
      return NextResponse.redirect(url)
    }
    // Sino, mandarlo al login principal (Admin)
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  if (user && !isApiRoute && !isPublicTracking) {
    const { data: profile } = await supabase.from('profiles')
      .select('is_active, employee_type, roles(name, permissions)')
      .eq('id', user.id).maybeSingle()
    if (!profile?.is_active) {
      const url = request.nextUrl.clone()
      url.pathname = isDriverRoute ? '/app/login' : '/login'
      if (request.nextUrl.pathname !== url.pathname) return NextResponse.redirect(url)
      return supabaseResponse
    }
    const role = Array.isArray(profile.roles) ? profile.roles[0] : profile.roles
    const permissions = Array.isArray(role?.permissions) ? role.permissions : []
    hasDashboardAccess = profile.employee_type !== 'CONDUCTOR' &&
      (isSystemAdminRole(role?.name) || permissions.includes('dashboard'))
    if (!isDriverRoute && !isLoginPage && !hasDashboardAccess) {
      return NextResponse.redirect(new URL('/login', request.url))
    }
    if (isDriverRoute && !isDriverLoginPage && !isDriverRegisterPage && profile.employee_type === 'CONDUCTOR') {
      const { data: driver } = await supabase.from('drivers').select('is_active')
        .eq('profile_id', user.id).maybeSingle()
      if (!driver?.is_active) return NextResponse.redirect(new URL('/app/login', request.url))
    }
  }

  // Si YA está autenticado e intenta ir a la página de login (para evitar que vea el login si ya tiene sesión)
  if (user && isLoginPage && hasDashboardAccess) {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|apk)$).*)',
  ],
}
