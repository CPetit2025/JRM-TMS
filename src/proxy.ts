import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { isDispatchAuditorRole, dispatchAuditorPathAllowed, roleDeniesPath } from '@/lib/roles'
import { canOpenPath, hasWebAccess } from '@/lib/nav/web-access'
import { assertDeploymentIsolation, wmsRouteAllowed } from '@/lib/deployment-isolation.mjs'

export async function proxy(request: NextRequest) {
  const wmsDeployment = process.env.NEXT_PUBLIC_DEPLOYMENT_SYSTEM === 'wms'
  if (!wmsDeployment && (request.nextUrl.pathname === '/almacen' || request.nextUrl.pathname.startsWith('/almacen/'))) {
    return NextResponse.json({error:'WMS requiere su sitio independiente.'},{status:404})
  }
  if (wmsDeployment) {
    assertDeploymentIsolation('wms', process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_WMS_ENVIRONMENT)
    if (!wmsRouteAllowed(request.nextUrl.pathname, request.method)) {
      if (request.nextUrl.pathname.startsWith('/api')) return NextResponse.json({ error: 'Ruta no disponible en WMS' }, { status: 404 })
      return NextResponse.redirect(new URL('/almacen', request.url))
    }
  }
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
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
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

  // Preserve refreshed/removed auth cookies on redirects as well as normal responses.
  const redirect = (url: URL) => {
    const response = NextResponse.redirect(url)
    supabaseResponse.cookies.getAll().forEach(cookie => response.cookies.set(cookie))
    return response
  }

  // refreshes the auth token and gets the user
  const { data: { user } } = await supabase.auth.getUser()

  const isLoginPage = request.nextUrl.pathname.startsWith('/login')
  const isWarehouseLoginPage = request.nextUrl.pathname === '/almacen/login'
  const isWarehousePath = request.nextUrl.pathname === '/almacen' || request.nextUrl.pathname.startsWith('/almacen/')
  const isLegacyAptPath = request.nextUrl.pathname === '/apt' || request.nextUrl.pathname.startsWith('/apt/')
  const isDriverLoginPage = request.nextUrl.pathname.startsWith('/app/login')
  const isDriverRegisterPage = request.nextUrl.pathname.startsWith('/app/register')
  const isDriverRoute = request.nextUrl.pathname.startsWith('/app')
  const isApiRoute = request.nextUrl.pathname.startsWith('/api')
  const isPublicTracking = request.nextUrl.pathname.startsWith('/tracking/')
  // Enlace de «¿Olvidaste tu contraseña?»: abre aunque haya otra sesión iniciada en el navegador
  const isPasswordReset = request.nextUrl.pathname === '/login/restablecer'
  let hasDashboardAccess = false
  let operativeDestination: string | null = null
  
  // Si no está autenticado y NO está en una página de login ni API
  if (!user && !isLoginPage && !isWarehouseLoginPage && !isDriverLoginPage && !isDriverRegisterPage && !isApiRoute && !isPublicTracking) {
    // Si intenta ir a la app operativa, mandarlo a su login
    if (isDriverRoute) {
      const url = request.nextUrl.clone()
      url.pathname = '/app/login'
      return redirect(url)
    }
    // Sino, mandarlo al login principal (Admin)
    const url = request.nextUrl.clone()
    url.pathname = wmsDeployment && (isWarehousePath || isLegacyAptPath) ? '/almacen/login' : '/login'
    return redirect(url)
  }

  if (user && !isApiRoute && !isPublicTracking && !isPasswordReset) {
    const { data: profile } = await supabase.from('profiles')
      .select('is_active, employee_type, roles(name, permissions)')
      .eq('id', user.id).maybeSingle()
    if (!profile?.is_active) {
      const url = request.nextUrl.clone()
      url.pathname = process.env.NEXT_PUBLIC_DEPLOYMENT_SYSTEM === 'wms' ? '/almacen/login' : isDriverRoute ? '/app/login' : '/login'
      if (request.nextUrl.pathname !== url.pathname) return redirect(url)
      return supabaseResponse
    }
    operativeDestination = profile.employee_type === 'CONDUCTOR' ? '/app' : '/app/actividades'
    const role = Array.isArray(profile.roles) ? profile.roles[0] : profile.roles
    const permissions = Array.isArray(role?.permissions) ? role.permissions : []
    const systemAdmin = role?.name === 'Administrador'
    const hasWarehouseAccess = wmsDeployment && (systemAdmin || permissions.some(p => ['almacen-lectura', 'almacen-etiquetado', 'almacen-picking', 'almacen-packing', 'almacen-carga', 'almacen-supervisor', 'apt', 'apt-carga'].some(key => p === key || p.startsWith(`${key}:`))))
    if (isLegacyAptPath && wmsDeployment) {
      const url = request.nextUrl.clone()
      url.pathname = `/almacen${request.nextUrl.pathname}`
      return redirect(url)
    }
    const auditor = profile.employee_type !== 'CONDUCTOR' && isDispatchAuditorRole(role?.name, permissions)
    hasDashboardAccess = profile.employee_type !== 'CONDUCTOR' &&
      (hasWebAccess(role?.name, permissions) || auditor)
    if (auditor && !dispatchAuditorPathAllowed(request.nextUrl.pathname)) {
      return redirect(new URL('/despacho/documentos?vista=salida', request.url))
    }
    if (isWarehousePath && !isWarehouseLoginPage && !hasWarehouseAccess) {
      return redirect(new URL(hasDashboardAccess ? '/' : '/login', request.url))
    }
    if (isWarehousePath && !isWarehouseLoginPage && hasWarehouseAccess) {
      const path = request.nextUrl.pathname
      const required = path.startsWith('/almacen/auditoria') ? ['almacen-supervisor'] : path.startsWith('/almacen/maestros') ? ['almacen-supervisor']
        : path.startsWith('/almacen/conciliacion') ? ['almacen-carga','almacen-supervisor','apt-carga']
        : path.startsWith('/almacen/etiquetado') ? ['almacen-etiquetado','almacen-supervisor']
        : path.startsWith('/almacen/apt') ? ['apt','apt-carga','almacen-lectura','almacen-etiquetado','almacen-picking','almacen-packing','almacen-carga','almacen-supervisor']
        : path.startsWith('/almacen/paquetes') || path.startsWith('/almacen/lpn') ? ['almacen-lectura','almacen-packing','almacen-carga','almacen-supervisor']
        : path.startsWith('/almacen/tareas') ? ['almacen-lectura','almacen-picking','almacen-packing','almacen-carga','almacen-supervisor'] : null
      if (required && role?.name !== 'Administrador' && !permissions.some(p => required.some(key => p === key || p.startsWith(`${key}:`)))) {
        return redirect(new URL('/almacen', request.url))
      }
    }
    if (!isDriverRoute && !isLoginPage && !isWarehouseLoginPage && !hasDashboardAccess && !(isWarehousePath && hasWarehouseAccess)) {
      return redirect(new URL(hasWarehouseAccess ? '/almacen' : '/login', request.url))
    }
    if (!isDriverRoute && roleDeniesPath(role?.name, request.nextUrl.pathname, permissions)) {
      return redirect(new URL('/', request.url))
    }
    // Cada página exige el permiso de su opción del menú: la dirección escrita a mano no abre un módulo ajeno.
    if (!isDriverRoute && !isWarehousePath && !isLoginPage && !isWarehouseLoginPage && !auditor && !canOpenPath(role?.name, permissions, request.nextUrl.pathname)) {
      const home = new URL('/', request.url)
      home.searchParams.set('sin_acceso', request.nextUrl.pathname)
      return redirect(home)
    }
    if (isDriverRoute && !isDriverRegisterPage && profile.employee_type === 'CONDUCTOR') {
      const { data: driver } = await supabase.from('drivers').select('is_active')
        .eq('profile_id', user.id).maybeSingle()
      if (!driver?.is_active) {
        if (!isDriverLoginPage) return redirect(new URL('/app/login', request.url))
        return supabaseResponse
      }
    }
  }

  if (user && isDriverLoginPage && operativeDestination) {
    return redirect(new URL(operativeDestination, request.url))
  }

  if (user && isWarehouseLoginPage) {
    const { data: profile } = await supabase.from('profiles').select('roles(name, permissions)').eq('id', user.id).maybeSingle()
    const role = Array.isArray(profile?.roles) ? profile.roles[0] : profile?.roles
    const permissions = Array.isArray(role?.permissions) ? role.permissions : []
    if (role?.name === 'Administrador' || permissions.some(p => ['almacen-lectura', 'almacen-etiquetado', 'almacen-picking', 'almacen-packing', 'almacen-carga', 'almacen-supervisor', 'apt', 'apt-carga'].some(key => p === key || p.startsWith(`${key}:`)))) {
      return redirect(new URL('/almacen', request.url))
    }
  }

  // Si YA está autenticado e intenta ir a la página de login (para evitar que vea el login si ya tiene sesión)
  if (user && isLoginPage && hasDashboardAccess) {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    return redirect(url)
  }

  if (user && isLoginPage) {
    const { data: profile } = await supabase.from('profiles').select('roles(name, permissions)').eq('id', user.id).maybeSingle()
    const role = Array.isArray(profile?.roles) ? profile.roles[0] : profile?.roles
    const permissions = Array.isArray(role?.permissions) ? role.permissions : []
    if (role?.name === 'Administrador' || permissions.some(p => ['almacen-lectura', 'almacen-etiquetado', 'almacen-picking', 'almacen-packing', 'almacen-carga', 'almacen-supervisor', 'apt', 'apt-carga'].some(key => p === key || p.startsWith(`${key}:`)))) return redirect(new URL('/almacen', request.url))
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|apk)$).*)',
  ],
}
