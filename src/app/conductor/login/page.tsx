"use client"
import Image from 'next/image'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Truck, LogIn, Loader2, Eye, EyeOff } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'

export default function DriverLogin() {
  const router = useRouter()
  const [dni, setDni] = useState('')
  const [pin, setPin] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPin, setShowPin] = useState(false)
  const [rememberMe, setRememberMe] = useState(false)

  useEffect(() => {
    const savedDni = localStorage.getItem('jrm_saved_driver_dni')
    if (savedDni) {
      setDni(savedDni)
      setRememberMe(true)
    }
  }, [])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (dni.length < 8) {
      toast.error('Ingrese un DNI válido')
      return
    }
    
    if (pin.length < 4) {
      toast.error('Ingrese su PIN completo (4 dígitos)')
      return
    }
    
    setLoading(true)
    
    try {
      const supabase = createClient()
      
      const cleanDni = dni.trim()
      const cleanPin = pin.trim()

      const { data: driver, error } = await supabase
        .from('drivers')
        .select('id, first_name, last_name, document_number')
        .eq('document_number', cleanDni)
        .eq('pin', cleanPin)
        .single()

      if (error) {
        console.error('Supabase error en login:', error)
        toast.error(error.message === 'PGRST116' ? 'DNI o PIN incorrectos' : `Error: ${error.message}`)
        setLoading(false)
        return
      }
      
      if (!driver) {
        toast.error('DNI o PIN incorrectos')
        setLoading(false)
        return
      }

      toast.success(`Bienvenido, ${driver.first_name} ${driver.last_name}`)
      localStorage.setItem('jrm_driver', JSON.stringify(driver))
      
      if (rememberMe) {
        localStorage.setItem('jrm_saved_driver_dni', cleanDni)
      } else {
        localStorage.removeItem('jrm_saved_driver_dni')
      }
      
      router.push('/conductor/ruta')
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
          <h1 className="text-xl font-black text-[#002855] uppercase tracking-wide">Portal Conductor</h1>
          <p className="text-slate-500 text-sm mt-1">Acceso Operativo Móvil</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">DNI del Conductor</label>
            <input 
              type="tel"
              maxLength={8}
              placeholder="Ej. 45678901"
              className="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-[#002855] outline-none font-medium text-slate-900"
              value={dni}
              onChange={(e) => setDni(e.target.value)}
            />
          </div>
          
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">PIN de Acceso</label>
            <div className="relative">
              <input 
                type={showPin ? "text" : "password"}
                maxLength={4}
                placeholder="****"
                className="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-[#002855] outline-none font-medium text-center tracking-widest text-lg text-slate-900"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
              <button 
                type="button"
                onClick={() => setShowPin(!showPin)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 focus:outline-none"
              >
                {showPin ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
              </button>
            </div>
          </div>

          <div className="flex items-center mt-2">
            <input
              id="remember"
              type="checkbox"
              className="w-4 h-4 rounded border-slate-300 text-[#002855] focus:ring-[#002855]"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
            />
            <label htmlFor="remember" className="ml-2 text-sm text-slate-600 font-medium cursor-pointer">
              Recordar mis credenciales
            </label>
          </div>

          <button 
            type="submit" 
            disabled={loading}
            className="w-full bg-[#002855] text-white py-4 rounded-xl font-bold text-lg shadow-lg hover:bg-[#001f44] flex justify-center items-center gap-2 mt-4 transition-all active:scale-95"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <LogIn className="w-5 h-5" />}
            Ingresar
          </button>
        </form>
      </div>
      
      <p className="text-blue-200 text-xs mt-8">Versión 1.0.0 - JRM Logistics MVP</p>
    </div>
  )
}
