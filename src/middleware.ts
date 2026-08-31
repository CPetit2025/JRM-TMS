import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
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
  const isDriverLoginPage = request.nextUrl.pathname.startsWith('/conductor/login')
  const isDriverRoute = request.nextUrl.pathname.startsWith('/conductor')
  const isApiRoute = request.nextUrl.pathname.startsWith('/api')
  
  // Si no está autenticado y NO está en una página de login ni API
  if (!user && !isLoginPage && !isDriverLoginPage && !isApiRoute) {
    // Si intenta entrar a una ruta de conductor, lo mandamos al login de conductor
    if (isDriverRoute) {
      const url = request.nextUrl.clone()
      url.pathname = '/conductor/login'
      return NextResponse.redirect(url)
    }
    
    // De lo contrario, lo mandamos al login principal (Admin)
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  // Si YA está autenticado e intenta ir a la página de login (para evitar que vea el login si ya tiene sesión)
  if (user && isLoginPage) {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
