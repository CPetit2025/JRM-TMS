"use client"

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'

export default function LoginPage() {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)

  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('admin')

  const supabase = createClient()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    
    try {
      // 1. Formatear usuario al correo estándar corporativo
      const rawUser = username.toLowerCase().trim()
      const email = rawUser.includes('@') ? rawUser : `${rawUser}@jrm.com`
      
      // 2. Autenticar con Supabase Real
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      })

      if (error) {
        throw new Error('Credenciales incorrectas o usuario inactivo.')
      }

      // 3. Obtener el perfil real de la BD para sacar el rol
      if (data.user) {
        const { data: profileData } = await supabase
          .from('profiles')
          .select('roles(name)')
          .eq('id', data.user.id)
          .single()

        let roleName = 'operador'
        if (profileData && profileData.roles) {
           roleName = Array.isArray(profileData.roles) 
             ? profileData.roles[0]?.name 
             : (profileData.roles as any)?.name
        }
        
        // MVP: Forzar rol de administrador para el usuario principal si la BD no lo asignó
        if (email === 'admin@jrm.com' || email === 'admin') {
          roleName = 'admin'
        }
        
        // Guardar en localStorage para UI (Sidebar), pero la seguridad real ya está en la cookie HTTP
        localStorage.setItem('userRole', roleName ? roleName.toLowerCase() : 'operador')
        
        toast.success('Sesión iniciada correctamente')
        router.push('/')
      }
    } catch (err: any) {
      toast.error(err.message)
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex bg-slate-50">
      {/* Sección Izquierda - Imagen Corporativa */}
      <div className="hidden lg:flex lg:w-1/2 relative bg-[#002855] overflow-hidden items-center justify-center">
        {/* Abstract pattern / background */}
        <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'url("https://www.transparenttextures.com/patterns/cubes.png")' }}></div>
        <div className="absolute top-0 left-0 w-full h-2 bg-[#cf152d]"></div>
        <div className="z-10 px-12 text-white">
          <img 
            src="https://jrmsac.com.pe/wp-content/themes/JRMTheme/static/img/logo-jrm-borde-blaco-lema.png" 
            alt="JRM Logo" 
            className="h-16 mb-8 object-contain"
          />
          <h1 className="text-4xl font-bold mb-6">Sistemas de Almacenamiento</h1>
          <p className="text-xl text-blue-100 max-w-lg leading-relaxed">
            Gestión inteligente de despachos, transporte y entregas. Torre de control operativa para optimizar toda tu cadena de suministro.
          </p>
          <div className="mt-12 flex gap-4 items-center">
             <div className="w-16 h-1 bg-[#cf152d]"></div>
             <p className="font-semibold uppercase tracking-widest text-sm">TORRE DE CONTROL TMS</p>
          </div>
        </div>
      </div>

      {/* Sección Derecha - Login Form */}
      <div className="flex-1 flex flex-col justify-center items-center px-8 sm:px-12 relative">
        <div className="absolute top-8 right-12">
           <span className="text-sm font-semibold text-slate-400 tracking-wider">JRM S.A.C.</span>
        </div>

        <div className="w-full max-w-md">
          <div className="text-center mb-10">
            <h2 className="text-3xl font-bold text-slate-800">Iniciar Sesión</h2>
            <p className="text-slate-500 mt-2">Ingresa tus credenciales para acceder a la plataforma</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Usuario</label>
              <input 
                type="text" 
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-4 py-3 bg-white text-slate-900 rounded-lg border border-slate-300 focus:ring-2 focus:ring-[#002855] focus:border-[#002855] outline-none transition-all"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Contraseña</label>
              <input 
                type="password" 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 bg-white text-slate-900 rounded-lg border border-slate-300 focus:ring-2 focus:ring-[#002855] focus:border-[#002855] outline-none transition-all"
                required
              />
            </div>

            <div className="flex items-center justify-between">
              <label className="flex items-center">
                <input type="checkbox" className="w-4 h-4 text-[#002855] rounded border-slate-300 focus:ring-[#002855]" />
                <span className="ml-2 text-sm text-slate-600">Recordarme</span>
              </label>
              <a href="#" className="text-sm text-[#002855] hover:text-[#cf152d] font-medium transition-colors">¿Olvidaste tu contraseña?</a>
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
        </div>
      </div>
    </div>
  )
}
