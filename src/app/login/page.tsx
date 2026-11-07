"use client"

import { AppVersionInfo } from '@/components/AppVersionInfo'
import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { PublicRegistrationModal } from '@/components/forms/PublicRegistrationModal'
import { Download } from 'lucide-react'
import { isDispatchAuditorRole, normalizeRoleName } from '@/lib/roles'
import { hasWebAccess } from '@/lib/nav/web-access'
import { loginSystemForDatabase, remoteLoginUrl, type LoginSystem } from '@/lib/login-system'

export default function LoginPage() {
  const router = useRouter()
  const pathname = usePathname()
  const warehouseLogin = pathname === '/almacen/login'
  const localSystem = loginSystemForDatabase(process.env.NEXT_PUBLIC_SUPABASE_URL)
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
  const [selectedSystem, setSelectedSystem] = useState<LoginSystem>(warehouseLogin ? 'almacen' : localSystem || 'tms')
  const localLogin = selectedSystem === localSystem

  const supabase = createClient()
  const [resetOpen, setResetOpen] = useState(false)
  const [resetSending, setResetSending] = useState(false)
  const [resetSent, setResetSent] = useState(false)

  // «¿Olvidaste tu contraseña?»: Supabase envía al correo un enlace que abre /login/restablecer para crear una nueva
  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!localLogin) return
    const rawUser = username.toLowerCase().trim()
    if (!rawUser) { toast.error('Escribe tu usuario o correo corporativo'); return }
    const email = rawUser.includes('@') ? rawUser : `${rawUser}@jrmsac.com.pe`
    setResetSending(true)
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/login/restablecer` })
    setResetSending(false)
    if (error && /rate|seconds|too many/i.test(error.message)) { toast.error('Ya se envió un enlace hace poco. Espera unos minutos e inténtalo de nuevo.'); return }
    if (error) { toast.error('No se pudo enviar el enlace. Inténtalo más tarde o pide al administrador que restablezca tu contraseña.'); return }
    // Mismo mensaje exista o no la cuenta: no revela qué correos están registrados
    setResetSent(true)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    // Switch sites before authentication. Never forward credentials or sessions.
    if (!localLogin) {
      try {
        if (!localSystem) throw new Error('No se pudo identificar el sistema. Contacta al administrador.')
        const origin = selectedSystem === 'tms' ? process.env.NEXT_PUBLIC_TMS_ORIGIN : process.env.NEXT_PUBLIC_WMS_ORIGIN
        window.location.assign(remoteLoginUrl(selectedSystem, origin, window.location.origin))
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'No se pudo abrir el sistema.')
      }
      return
    }
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
          .select('role_id, roles(name, permissions), is_active, employee_type')
          .eq('id', data.user.id)
          .single()

        if (!profileData || profileData.is_active !== true) {
          await supabase.auth.signOut()
          throw new Error('Tu cuenta está pendiente de aprobación por un Administrador.')
        }

        // Aprobada pero sin rol: no es una cuenta del Portal Operativo, falta que el administrador le asigne su rol
        if (!profileData.role_id && profileData.employee_type !== 'CONDUCTOR') {
          await supabase.auth.signOut()
          throw new Error('Tu cuenta está activa pero aún no tiene un rol asignado. Comunícate con el Administrador del sistema.')
        }

        let roleName = 'operador'
        let permissions: string[] = []
        
        if (profileData && profileData.roles) {
           const roleObj = Array.isArray(profileData.roles) ? profileData.roles[0] : (profileData.roles as any)
           roleName = roleObj?.name || 'operador'
           permissions = roleObj?.permissions || []
        }

        const hasWarehouseAccess = roleName === 'Administrador' || permissions.some(p => ['almacen-lectura', 'almacen-etiquetado', 'almacen-picking', 'almacen-packing', 'almacen-carga', 'almacen-supervisor', 'apt', 'apt-carga'].some(key => p === key || p.startsWith(`${key}:`)))
        const wantsWarehouse = selectedSystem === 'almacen'
        if (profileData?.employee_type === 'CONDUCTOR' || (wantsWarehouse ? !hasWarehouseAccess : !hasWebAccess(roleName, permissions) && !isDispatchAuditorRole(roleName, permissions))) {
          await supabase.auth.signOut()
          throw new Error(wantsWarehouse ? 'Tu usuario no tiene acceso al Portal de Almacén. Solicita el permiso al administrador.' : 'Tu usuario no tiene acceso al TMS. Solicita el permiso al administrador.')
        }
        
        // Guardar en localStorage para UI (Sidebar)
        localStorage.setItem('userRole', normalizeRoleName(roleName))
        localStorage.setItem('userPermissions', JSON.stringify(permissions))
        
        toast.success('Sesión iniciada correctamente')
        router.push(wantsWarehouse ? '/almacen' : '/')
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
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.22em] text-blue-200 sm:text-sm">JRM · Ecosistema logístico</p>
          <h1 className="mb-3 text-2xl font-bold leading-tight sm:text-3xl lg:mb-5 lg:text-4xl">Una plataforma para toda la operación</h1>
          <p className="max-w-lg text-sm leading-relaxed text-blue-100 sm:text-base lg:text-lg">
            Accede a las herramientas de transporte y almacén desde un mismo punto de acceso.
          </p>
          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:mt-9">
            <div className={`rounded-xl border p-4 ${selectedSystem === 'tms' ? 'border-white/50 bg-white/15' : 'border-white/20 bg-[#001f43]/35'}`}>
              <p className="text-sm font-bold sm:text-base">TMS</p>
              <p className="mt-1 text-xs leading-relaxed text-blue-100 sm:text-sm">Transporte, despacho y seguimiento de entregas</p>
            </div>
            <div className={`rounded-xl border p-4 ${selectedSystem === 'almacen' ? 'border-white/50 bg-white/15' : 'border-white/20 bg-[#001f43]/35'}`}>
              <p className="text-sm font-bold sm:text-base">Almacén</p>
              <p className="mt-1 text-xs leading-relaxed text-blue-100 sm:text-sm">Recepción, inventario y preparación de pedidos</p>
            </div>
          </div>
          <div className="mt-5 flex items-start gap-3 lg:mt-12 lg:gap-4">
            <div aria-hidden="true" className="mt-1.5 h-1 w-8 shrink-0 bg-[#cf152d] lg:mt-2 lg:w-16"></div>
            <div className="min-w-0 space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-widest sm:text-xs lg:text-sm">PLATAFORMA LOGÍSTICA JRM</p>
              <p className="text-[10px] font-medium uppercase tracking-widest text-blue-200 sm:text-xs lg:text-sm">TRANSPORTE · ALMACÉN · DISTRIBUCIÓN</p>
            </div>
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
            <h2 className="text-2xl font-bold text-slate-800 sm:text-3xl">{resetOpen ? 'Recuperar contraseña' : 'Iniciar Sesión'}</h2>
            <p className="mt-2 text-sm text-slate-500 sm:text-base">{resetOpen ? 'Te enviamos un enlace a tu correo corporativo' : 'Elige el sistema y accede con tu cuenta corporativa'}</p>
          </div>

          {resetOpen ? <form onSubmit={handleReset} className="space-y-4 sm:space-y-6">
            <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-slate-700">
              {resetSent
                ? <>Si <b>{username.includes('@') ? username.trim().toLowerCase() : `${username.trim().toLowerCase()}@jrmsac.com.pe`}</b> tiene una cuenta, te enviamos un enlace para crear una nueva contraseña. Revisa tu bandeja de entrada y el correo no deseado, y ábrelo en este mismo navegador.</>
                : 'Escribe tu usuario o correo corporativo y te enviaremos un enlace para crear una nueva contraseña.'}
            </div>
            <div>
              <label htmlFor="reset-username" className="block text-sm font-medium text-slate-700 mb-2">Usuario o correo</label>
              <input type="text" id="reset-username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username}
                onChange={(e) => { setUsername(e.target.value); setResetSent(false) }} placeholder="nombre.apellido@jrmsac.com.pe"
                className="min-w-0 w-full px-4 py-3 text-base bg-white text-slate-900 rounded-lg border border-slate-300 focus:ring-2 focus:ring-[#002855] focus:border-[#002855] outline-none transition-all" required />
            </div>
            <button type="submit" disabled={resetSending}
              className="w-full py-3 px-4 bg-[#002855] hover:bg-[#001d3d] text-white font-medium rounded-lg shadow-md transition-all flex items-center justify-center disabled:opacity-70">
              {resetSending && <Loader2 className="w-5 h-5 mr-2 animate-spin" />}{resetSent ? 'Enviar de nuevo' : 'Enviar enlace'}
            </button>
            <p className="text-xs text-slate-500">¿No llega el correo? El Administrador del sistema puede asignarte una contraseña nueva desde Usuarios.</p>
            <button type="button" onClick={() => { setResetOpen(false); setResetSent(false) }} className="min-h-11 w-full text-sm font-medium text-[#002855] hover:text-[#cf152d]">Volver a iniciar sesión</button>
          </form> : <form onSubmit={handleSubmit} className="space-y-4 sm:space-y-6">
            <div>
              <label htmlFor="login-system" className="mb-2 block text-sm font-medium text-slate-700">Sistema al que deseas ingresar</label>
              <select id="login-system" disabled={isLoading} value={selectedSystem} onChange={event => {
                setSelectedSystem(event.target.value as LoginSystem)
                setUsername('')
                setPassword('')
                setResetOpen(false)
                setResetSent(false)
              }}
                className="min-h-12 w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none transition-all focus:border-[#002855] focus:ring-2 focus:ring-[#002855]">
                <option value="tms">TMS · Transporte y despacho</option>
                <option value="almacen">Almacén · Operación WMS</option>
              </select>
            </div>
            {localLogin ? <>
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
              <button type="button" onClick={() => setResetOpen(true)} className="inline-flex min-h-11 items-center text-sm text-[#002855] hover:text-[#cf152d] font-medium transition-colors">¿Olvidaste tu contraseña?</button>
            </div>

            </> : <p role="status" className="rounded-lg bg-blue-50 p-4 text-sm text-slate-700">
              Continúa al acceso de {selectedSystem === 'tms' ? 'TMS' : 'Almacén'} para ingresar con tu cuenta de ese sistema.
            </p>}

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
                localLogin ? 'Ingresar' : `Continuar a ${selectedSystem === 'tms' ? 'TMS' : 'Almacén'}`
              )}
            </button>
          </form>}

          {localLogin && process.env.NEXT_PUBLIC_DEPLOYMENT_SYSTEM !== 'wms' && <div className="mt-5 text-center text-sm text-slate-600 sm:mt-8">
            ¿No tienes cuenta?{' '}
            <button 
              onClick={() => setIsRegisterModalOpen(true)}
              type="button"
              className="min-h-11 text-[#cf152d] hover:text-red-700 font-semibold hover:underline"
            >
              Regístrate aquí
            </button>
          </div>}

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
