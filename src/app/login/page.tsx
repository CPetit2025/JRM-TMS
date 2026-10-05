"use client"

import { AppVersionInfo } from '@/components/AppVersionInfo'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { PublicRegistrationModal } from '@/components/forms/PublicRegistrationModal'
import { Download } from 'lucide-react'
import { isSystemAdminRole, normalizeRoleName } from '@/lib/roles'

export default function LoginPage() {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [isRegisterModalOpen, setIsRegisterModalOpen] = useState(false)
  const [androidInstallerUrl, setAndroidInstallerUrl] = useState<string | null>(null)
  const [androidRelease, setAndroidRelease] = useState<{ version: string; build_number: number | null; release_date: string | null } | null>(null)

  useEffect(() => {
    fetch('/api/app-version', { cache: 'no-store' }).then(response => response.json()).then(data => {
      const value = data.android?.installer_url
      if (typeof value === 'string' && new URL(value).protocol === 'https:') setAndroidInstallerUrl(value)
      if (data.android) setAndroidRelease(data.android)
    }).catch(() => {})
  }, [])

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const supabase = createClient()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    
    try {
      // 1. Formatear usuario al correo estándar corporativo nuevo
      const rawUser = username.toLowerCase().trim()
      const email = rawUser.includes('@') ? rawUser : `${rawUser}@jrmsac.com.pe`
      
      // 2. Autenticar con Supabase Real
      let authResponse = await supabase.auth.signInWithPassword({
        email,
        password,
      })

      // Fallback temporal: Si falla y no habían puesto '@', intentar con el dominio antiguo '@jrm.com'
      if (authResponse.error && !rawUser.includes('@')) {
        const oldEmail = `${rawUser}@jrm.com`
        authResponse = await supabase.auth.signInWithPassword({
          email: oldEmail,
          password,
        })
      }

      if (authResponse.error) {
        throw new Error('Credenciales incorrectas.')
      }

      const { data } = authResponse;

      // 3. Obtener el perfil real de la BD para sacar el rol y estado
      if (data.user) {
        const { data: profileData } = await supabase
          .from('profiles')
          .select('roles(name, permissions), is_active')
          .eq('id', data.user.id)
          .single()

        if (!profileData || profileData.is_active !== true) {
          await supabase.auth.signOut()
          throw new Error('Tu cuenta está pendiente de aprobación por un Administrador.')
        }

        let roleName = 'operador'
        let permissions: string[] = []
        
        if (profileData && profileData.roles) {
           const roleObj = Array.isArray(profileData.roles) ? profileData.roles[0] : (profileData.roles as any)
           roleName = roleObj?.name || 'operador'
           permissions = roleObj?.permissions || []
        }

        if (!isSystemAdminRole(roleName) && !permissions.includes('dashboard')) {
          await supabase.auth.signOut()
          throw new Error('Esta cuenta pertenece al Portal Operativo. Ingresa desde /app/login.')
        }
        
        // Guardar en localStorage para UI (Sidebar)
        localStorage.setItem('userRole', normalizeRoleName(roleName))
        localStorage.setItem('userPermissions', JSON.stringify(permissions))
        
        toast.success('Sesión iniciada correctamente')
        router.push('/')
      }
    } catch (err: any) {
      toast.error(err.message)
      setIsLoading(false)
    }
  }

  return (
    <div className="flex min-h-dvh min-w-0 flex-col bg-slate-50 lg:flex-row">
      {/* La misma identidad corporativa: cabecera en móvil y panel lateral en escritorio. */}
      <section aria-label="Presentación de JRM" className="relative flex shrink-0 items-center justify-center overflow-hidden bg-[#002855] px-6 py-7 sm:px-12 sm:py-9 lg:w-1/2 lg:p-12">
        {/* Abstract pattern / background */}
        <div aria-hidden="true" className="absolute inset-0 opacity-20" style={{ backgroundImage: 'url("https://www.transparenttextures.com/patterns/cubes.png")' }}></div>
        <div aria-hidden="true" className="absolute top-0 left-0 h-2 w-full bg-[#cf152d]"></div>
        <div className="relative z-10 w-full max-w-md text-white sm:max-w-lg">
          <div className="mb-5 flex items-center justify-between gap-3 lg:mb-8">
            <img
              src="/logo-jrm.png"
              alt="JRM Logo"
              width={600}
              height={249}
              className="h-12 w-auto max-w-[65%] object-contain sm:h-14 lg:h-16"
            />
            <span className="shrink-0 text-[10px] font-semibold tracking-wider text-blue-200 sm:text-xs lg:hidden">JRM S.A.C.</span>
          </div>
          <h1 className="mb-3 text-2xl font-bold leading-tight sm:text-3xl lg:mb-6 lg:text-4xl">Sistemas de Almacenamiento</h1>
          <p className="max-w-lg text-sm leading-relaxed text-blue-100 sm:text-base lg:text-xl">
            Gestión inteligente de despachos, transporte y entregas. Torre de control operativa para optimizar toda tu cadena de suministro.
          </p>
          <div className="mt-5 flex items-center gap-3 lg:mt-12 lg:gap-4">
             <div aria-hidden="true" className="h-1 w-8 shrink-0 bg-[#cf152d] lg:w-16"></div>
             <p className="text-[10px] font-semibold uppercase tracking-widest sm:text-xs lg:text-sm">TORRE DE CONTROL TMS</p>
          </div>
        </div>
      </section>

      {/* Sección Derecha - Login Form */}
      <main className="relative flex min-w-0 flex-1 flex-col items-center justify-center px-6 py-8 sm:px-12 sm:py-10 lg:py-20">
        <div className="absolute top-8 right-12 hidden lg:block">
           <span className="text-sm font-semibold text-slate-400 tracking-wider">JRM S.A.C.</span>
        </div>

        <div className="w-full max-w-md">
          <div className="mb-6 text-center lg:mb-10">
            <h2 className="text-2xl font-bold text-slate-800 sm:text-3xl">Iniciar Sesión</h2>
            <p className="mt-2 text-sm text-slate-500 sm:text-base">Ingresa tus credenciales para acceder a la plataforma</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4 sm:space-y-6">
            <div>
              <label htmlFor="login-username" className="block text-sm font-medium text-slate-700 mb-2">Usuario</label>
              <input 
                type="text" 
                id="login-username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="min-w-0 w-full px-4 py-3 text-base bg-white text-slate-900 rounded-lg border border-slate-300 focus:ring-2 focus:ring-[#002855] focus:border-[#002855] outline-none transition-all"
                required
              />
            </div>

            <div>
              <label htmlFor="login-password" className="block text-sm font-medium text-slate-700 mb-2">Contraseña</label>
              <input 
                type="password" 
                id="login-password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="min-w-0 w-full px-4 py-3 text-base bg-white text-slate-900 rounded-lg border border-slate-300 focus:ring-2 focus:ring-[#002855] focus:border-[#002855] outline-none transition-all"
                required
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-3">
              <label className="flex min-h-11 items-center">
                <input type="checkbox" className="w-4 h-4 text-[#002855] rounded border-slate-300 focus:ring-[#002855]" />
                <span className="ml-2 text-sm text-slate-600">Recordarme</span>
              </label>
              <a href="#" className="inline-flex min-h-11 items-center text-sm text-[#002855] hover:text-[#cf152d] font-medium transition-colors">¿Olvidaste tu contraseña?</a>
            </div>

            <button 
              type="submit" 
              disabled={isLoading}
              className="w-full py-3 px-4 bg-[#002855] hover:bg-[#001d3d] text-white font-medium rounded-lg shadow-md hover:shadow-lg transition-all flex items-center justify-center disabled:opacity-70 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  Iniciando sesión...
                </>
              ) : (
                'Ingresar'
              )}
            </button>
          </form>

          <div className="mt-5 text-center text-sm text-slate-600 sm:mt-8">
            ¿No tienes cuenta?{' '}
            <button 
              onClick={() => setIsRegisterModalOpen(true)}
              type="button"
              className="min-h-11 text-[#cf152d] hover:text-red-700 font-semibold hover:underline"
            >
              Regístrate aquí
            </button>
          </div>

          <div className="mt-6 pt-6 border-t border-slate-200">
            {androidInstallerUrl ? (
              <a href={androidInstallerUrl} target="_blank" rel="noopener noreferrer"
                className="w-full py-3 px-4 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg shadow-sm hover:shadow-md transition-all flex items-center justify-center gap-2">
                <Download className="h-5 w-5 shrink-0" /><span className="text-center">Descargar App para Conductores (APK)</span>
              </a>
            ) : (
              <p className="text-center text-sm text-slate-600">La descarga Android estará disponible cuando se publique la versión firmada.</p>
            )}
            <p className="text-xs text-center text-slate-500 mt-3">
              Versión nativa Android con rastreo GPS en segundo plano.
              {androidRelease && <> APK {androidRelease.version}{androidRelease.build_number ? ` (build ${androidRelease.build_number})` : ''}
                {androidRelease.release_date && ` · publicado ${new Date(androidRelease.release_date).toLocaleDateString('es-PE', { timeZone: 'America/Lima' })}`}.
                {' '}Las pantallas se actualizan solas: no hace falta reinstalar.</>}
            </p>
            <AppVersionInfo className="mt-3 text-center" />
          </div>
        </div>
      </main>

      <PublicRegistrationModal 
        isOpen={isRegisterModalOpen}
        onClose={() => setIsRegisterModalOpen(false)}
      />
    </div>
  )
}
