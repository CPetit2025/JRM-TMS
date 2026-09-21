"use client"
import Image from 'next/image'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Eye, EyeOff, UserCircle, Phone, FileText, Briefcase } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'

export default function RegisterDriver() {
  const router = useRouter()
  const supabase = createClient()
  
  const [form, setForm] = useState({
    dni: '',
    firstName: '',
    lastName: '',
    phone: '',
    licenseNumber: '',
    pin: '',
    carrierId: ''
  })
  
  const [carriers, setCarriers] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [showPin, setShowPin] = useState(false)

  useEffect(() => {
    const fetchCarriers = async () => {
      const { data } = await supabase.from('carriers').select('id, business_name').order('business_name')
      if (data) setCarriers(data)
    }
    fetchCarriers()
  }, [])

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!form.dni || !form.firstName || !form.lastName || !form.pin || !form.carrierId || !form.licenseNumber) {
      toast.error('Complete todos los campos obligatorios')
      return
    }

    if (form.pin.length < 8) {
      toast.error('La contraseña debe tener al menos 8 caracteres')
      return
    }

    setLoading(true)
    
    try {
      const res = await fetch('/api/register-driver', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      })

      const result = await res.json()

      if (!res.ok) {
        toast.error(result.error || 'Error al registrar la cuenta')
        return
      }

      toast.success('Cuenta creada. Espera la aprobación de un administrador para iniciar sesión.')
      router.push('/app/login')
      
    } catch (err: any) {
      console.error(err)
      toast.error('Error de conexión. Inténtalo de nuevo.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#002855] flex flex-col items-center justify-center p-4 py-8">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl p-6">
        <div className="flex flex-col items-center mb-6 text-center">
          <Image 
            src="/jrm-logo-v2.png" 
            alt="JRM Logo" 
            width={160} 
            height={64} 
            className="object-contain mb-2"
          />
          <h1 className="text-xl font-black text-[#002855] uppercase tracking-wide">Registro de Conductor</h1>
          <p className="text-sm text-slate-500 mt-1">Crea tu cuenta para acceder a la app</p>
        </div>

        <form onSubmit={handleRegister} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 sm:col-span-1">
              <label className="block text-xs font-semibold text-slate-700 mb-1">DNI *</label>
              <div className="relative">
                <UserCircle className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4" />
                <input 
                  type="text" required
                  value={form.dni} onChange={e => setForm({...form, dni: e.target.value.replace(/\D/g, '')})}
                  maxLength={8}
                  placeholder="DNI"
                  className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-[#002855] transition-all text-sm"
                />
              </div>
            </div>

            <div className="col-span-2 sm:col-span-1">
              <label className="block text-xs font-semibold text-slate-700 mb-1">Nro. Licencia *</label>
              <div className="relative">
                <FileText className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4" />
                <input 
                  type="text" required
                  value={form.licenseNumber} onChange={e => setForm({...form, licenseNumber: e.target.value.toUpperCase()})}
                  placeholder="Ej. Q12345678"
                  className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-[#002855] transition-all text-sm"
                />
              </div>
            </div>

            <div className="col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1">Nombres *</label>
              <input 
                type="text" required
                value={form.firstName} onChange={e => setForm({...form, firstName: e.target.value})}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-[#002855] transition-all text-sm"
              />
            </div>

            <div className="col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1">Apellidos *</label>
              <input 
                type="text" required
                value={form.lastName} onChange={e => setForm({...form, lastName: e.target.value})}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-[#002855] transition-all text-sm"
              />
            </div>

            <div className="col-span-2 sm:col-span-1">
              <label className="block text-xs font-semibold text-slate-700 mb-1">Celular</label>
              <div className="relative">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4" />
                <input 
                  type="text" 
                  value={form.phone} onChange={e => setForm({...form, phone: e.target.value})}
                  className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-[#002855] transition-all text-sm"
                />
              </div>
            </div>

            <div className="col-span-2 sm:col-span-1">
              <label className="block text-xs font-semibold text-slate-700 mb-1">Contraseña (mínimo 8 caracteres) *</label>
              <div className="relative">
                <input 
                  type={showPin ? "text" : "password"} required
                  value={form.pin} onChange={e => setForm({...form, pin: e.target.value})}
                  minLength={8}
                  placeholder="8 caracteres o más"
                  className="w-full pl-3 pr-10 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-[#002855] transition-all font-mono text-sm tracking-widest"
                />
                <button 
                  type="button"
                  onClick={() => setShowPin(!showPin)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 p-1"
                >
                  {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="col-span-2">
              <label className="block text-xs font-semibold text-slate-700 mb-1">Empresa Transportista *</label>
              <div className="relative">
                <Briefcase className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4" />
                <select 
                  required
                  value={form.carrierId} onChange={e => setForm({...form, carrierId: e.target.value})}
                  className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-[#002855] transition-all text-sm appearance-none"
                >
                  <option value="">Seleccione su empresa...</option>
                  {carriers.map(c => (
                    <option key={c.id} value={c.id}>{c.business_name}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full mt-4 bg-[#002855] hover:bg-[#001f40] text-white font-bold py-3 px-4 rounded-xl transition-colors duration-200 flex items-center justify-center shadow-lg active:scale-[0.98]"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Crear mi cuenta'}
          </button>
        </form>

        <div className="mt-6 text-center border-t border-slate-100 pt-4">
          <p className="text-sm text-slate-600">
            ¿Ya tienes cuenta?{' '}
            <button onClick={() => router.push('/app/login')} className="text-[#002855] font-bold hover:underline">
              Inicia sesión
            </button>
          </p>
        </div>
      </div>
    </div>
  )
}
