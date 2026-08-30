"use client"
import { useState, useEffect } from 'react'
import { User, Mail, Phone, Shield, Camera, Save, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

export default function PerfilPage() {
  const [role, setRole] = useState('cargando...')
  const [isLoading, setIsLoading] = useState(false)

  // Estados del formulario (simulados por ahora, en un caso real se cargarían de Supabase)
  const [profileData, setProfileData] = useState({
    firstName: 'Juan',
    lastName: 'Pérez',
    email: 'juan.perez@jrmsac.com.pe',
    phone: '987654321',
    document: '76543210'
  })

  useEffect(() => {
    const storedRole = localStorage.getItem('userRole')
    if (storedRole) {
      setRole(storedRole)
      // Actualizar los datos falsos dependiendo del rol para el mockup
      if (storedRole === 'admin') {
        setProfileData(prev => ({ ...prev, firstName: 'Administrador', lastName: 'Sistema' }))
      } else {
        setProfileData(prev => ({ ...prev, firstName: 'Operador', lastName: 'Logístico' }))
      }
    }
  }, [])

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    
    // Simular el guardado
    setTimeout(() => {
      setIsLoading(false)
      toast.success('Perfil actualizado correctamente')
    }, 1000)
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-800">Mi Perfil</h1>
        <p className="text-sm text-slate-500">Gestiona tu información personal y configuración de cuenta</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        
        {/* Tarjeta de Resumen Izquierda */}
        <div className="md:col-span-1 space-y-6">
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col items-center text-center">
            <div className="relative mb-4 group cursor-pointer">
              <div className="w-24 h-24 bg-slate-100 rounded-full flex items-center justify-center border-4 border-white shadow-md overflow-hidden">
                <User className="w-12 h-12 text-slate-400" />
              </div>
              <div className="absolute inset-0 bg-black/40 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <Camera className="w-6 h-6 text-white" />
              </div>
            </div>
            
            <h2 className="text-xl font-bold text-slate-800">{profileData.firstName} {profileData.lastName}</h2>
            <div className="flex items-center gap-2 mt-2 text-sm font-medium text-[#002855] bg-blue-50 px-3 py-1 rounded-full border border-blue-100">
              <Shield className="w-4 h-4" />
              <span className="capitalize">{role}</span>
            </div>
          </div>
        </div>

        {/* Formulario Derecha */}
        <div className="md:col-span-2">
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="p-6 border-b border-slate-200">
              <h3 className="text-lg font-semibold text-slate-800">Información Personal</h3>
            </div>
            
            <form onSubmit={handleSave} className="p-6 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Nombres</label>
                  <input 
                    type="text" 
                    required
                    className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                    value={profileData.firstName}
                    onChange={(e) => setProfileData({...profileData, firstName: e.target.value})}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Apellidos</label>
                  <input 
                    type="text" 
                    required
                    className="w-full px-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                    value={profileData.lastName}
                    onChange={(e) => setProfileData({...profileData, lastName: e.target.value})}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Documento de Identidad</label>
                  <input 
                    type="text" 
                    required
                    className="w-full px-3 py-2 bg-slate-50 text-slate-500 border border-slate-200 rounded-lg outline-none cursor-not-allowed"
                    value={profileData.document}
                    disabled
                  />
                  <p className="text-xs text-slate-400 mt-1">El documento no se puede modificar.</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Teléfono</label>
                  <div className="relative">
                    <Phone className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
                    <input 
                      type="text" 
                      className="w-full pl-9 pr-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                      value={profileData.phone}
                      onChange={(e) => setProfileData({...profileData, phone: e.target.value})}
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Correo Electrónico (Institucional)</label>
                <div className="relative">
                  <Mail className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
                  <input 
                    type="email" 
                    required
                    className="w-full pl-9 pr-3 py-2 bg-white text-slate-900 border border-slate-300 rounded-lg focus:ring-2 focus:ring-[#002855] outline-none"
                    value={profileData.email}
                    onChange={(e) => setProfileData({...profileData, email: e.target.value})}
                  />
                </div>
              </div>

              <div className="pt-6 border-t border-slate-200 flex justify-end">
                <button 
                  type="submit" 
                  disabled={isLoading}
                  className="px-6 py-2 bg-[#002855] text-white font-medium rounded-lg hover:bg-[#001d3d] transition-colors disabled:opacity-50 flex items-center gap-2"
                >
                  {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Guardar Cambios
                </button>
              </div>
            </form>
          </div>
        </div>

      </div>
    </div>
  )
}
