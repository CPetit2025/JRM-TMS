"use client"
import Image from 'next/image'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Eye, EyeOff, UserCircle } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'

export default function OperativeLogin() {
  const router = useRouter()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPin, setShowPin] = useState(false)
  const [rememberMe, setRememberMe] = useState(false)

  useEffect(() => {
    const savedId = localStorage.getItem('jrm_saved_operative_id')
    if (savedId) {
      setIdentifier(savedId)
      setRememberMe(true)
    }
  }, [])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!identifier.trim()) {
      toast.error('Ingrese un Usuario o DNI válido')
      return
    }
    
    if (!password.trim()) {
      toast.error('Ingrese su contraseña o PIN')
      return
    }
    
    setLoading(true)
    
    try {
      const supabase = createClient()
      
      const cleanId = identifier.trim()
      const cleanPass = password.trim()
      
      // Si es solo números (DNI), le agregamos @jrm.com (formato estándar operativo)
      const email = /^\d+$/.test(cleanId) ? `${cleanId}@jrm.com` : cleanId

      const { data, error } = await supabase.auth.signInWithPassword({
        email: email,
        password: cleanPass
      })

      if (error) {
        toast.error('Credenciales incorrectas')
        setLoading(false)
        return
      }

      toast.success('Bienvenido al Portal Operativo')
      
      if (rememberMe) {
        localStorage.setItem('jrm_saved_operative_id', cleanId)
      } else {
        localStorage.removeItem('jrm_saved_operative_id')
      }
      
      // Consultamos el perfil para saber a dónde redirigir
      const { data: profile } = await supabase
        .from('profiles')
        .select('employee_type')
        .eq('id', data.user.id)
        .single()
        
      if (profile?.employee_type === 'CONDUCTOR') {
        router.push('/app/ruta')
      } else {
        router.push('/app/actividades')
      }
      
    } catch (err) {
      toast.error('Ocurrió un error al intentar acceder')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#002855] flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-2xl p-6">
        <div className="flex flex-col items-center mb-6 text-center">
          <Image 
            src="/jrm-logo-v2.png" 
            alt="JRM Logo" 
            width={200} 
            height={80} 
            className="object-contain mb-4"
          />
          <h1 className="text-xl font-black text-[#002855] uppercase tracking-wide">Portal Operativo</h1>
          <p className="text-sm text-slate-500 mt-2">Conductores y Operarios</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-5">
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1">
              Usuario o DNI
            </label>
            <div className="relative">
              <UserCircle className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-5 h-5" />
              <input 
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="Ej. 74859632"
                className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#002855] focus:border-transparent transition-all font-medium"
                autoComplete="username"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1">
              Contraseña / PIN
            </label>
            <div className="relative">
              <input 
                type={showPin ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••"
                className="w-full pl-4 pr-12 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#002855] focus:border-transparent transition-all tracking-widest font-mono text-lg"
              />
              <button 
                type="button"
                onClick={() => setShowPin(!showPin)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 focus:outline-none p-1"
              >
                {showPin ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
              </button>
            </div>
          </div>

          <div className="flex items-center">
            <input 
              id="remember"
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              className="w-4 h-4 text-[#002855] bg-slate-100 border-slate-300 rounded focus:ring-[#002855]"
            />
            <label htmlFor="remember" className="ml-2 text-sm text-slate-600 font-medium cursor-pointer">
              Recordar mi usuario
            </label>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[#002855] hover:bg-[#001f40] text-white font-bold py-3.5 px-4 rounded-xl transition-colors duration-200 flex items-center justify-center shadow-lg active:scale-[0.98]"
          >
            {loading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              'Ingresar al Portal'
            )}
          </button>
        </form>

        <div className="mt-8 pt-6 border-t border-slate-100 text-center">
          <p className="text-xs text-slate-400 font-medium">
            JRM SCM v2.0 &bull; Área de Operaciones
          </p>
        </div>
      </div>
    </div>
  )
}
