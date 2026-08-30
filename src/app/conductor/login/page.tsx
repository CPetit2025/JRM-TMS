"use client"
import Image from 'next/image'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Truck, LogIn, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'

export default function DriverLogin() {
  const router = useRouter()
  const [dni, setDni] = useState('')
  const [pin, setPin] = useState('')
  const [loading, setLoading] = useState(false)

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
      
      const { data: driver, error } = await supabase
        .from('drivers')
        .select('first_name, last_name, document_number')
        .eq('document_number', dni)
        .eq('pin', pin)
        .single()

      if (error || !driver) {
        toast.error('DNI o PIN incorrectos')
        setLoading(false)
        return
      }

      toast.success(`Bienvenido, ${driver.first_name} ${driver.last_name}`)
      localStorage.setItem('jrm_driver', JSON.stringify(driver))
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
              className="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-[#002855] outline-none font-medium"
              value={dni}
              onChange={(e) => setDni(e.target.value)}
            />
          </div>
          
          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">PIN de Acceso</label>
            <input 
              type="password"
              maxLength={4}
              placeholder="****"
              className="w-full px-4 py-3 rounded-xl border border-slate-300 focus:ring-2 focus:ring-[#002855] outline-none font-medium text-center tracking-widest text-lg"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
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
