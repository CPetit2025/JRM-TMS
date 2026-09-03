"use client"

import { useState, useEffect } from 'react'
import { User, LogOut, ChevronRight, ShieldCheck, MapPin, Truck } from 'lucide-react'

export default function PerfilPage() {
  const [driverInfo, setDriverInfo] = useState({
    first_name: '',
    last_name: '',
    document_number: '',
    phone: '',
    license: '',
  })

  useEffect(() => {
    const driverData = localStorage.getItem('jrm_driver')
    if (driverData) {
      try {
        const parsed = JSON.parse(driverData)
        setDriverInfo({
          first_name: parsed.first_name || '',
          last_name: parsed.last_name || '',
          document_number: parsed.document_number || '',
          phone: parsed.phone || 'No registrado',
          license: parsed.license || 'No registrada',
        })
      } catch (e) {
        console.error("Error parsing driver data", e)
      }
    }
  }, [])

  const handleLogout = () => {
    localStorage.removeItem('jrm_driver')
    window.location.href = '/app/login'
  }

  const getInitials = () => {
    return `${driverInfo.first_name.charAt(0)}${driverInfo.last_name.charAt(0)}`.toUpperCase()
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Cabecera del perfil */}
      <div className="bg-[#002855] pb-24 pt-8 px-6 text-center text-white relative">
        <h1 className="text-xl font-bold mb-6">Mi Perfil</h1>
      </div>

      {/* Tarjeta de Información */}
      <div className="px-4 -mt-16">
        <div className="bg-white rounded-2xl shadow-md p-6 relative flex flex-col items-center">
          {/* Avatar (Placeholder) */}
          <div className="w-24 h-24 bg-blue-100 rounded-full border-4 border-white shadow-sm flex items-center justify-center text-[#002855] text-3xl font-bold -mt-16 mb-4">
            {driverInfo.first_name ? getInitials() : <User className="w-12 h-12" />}
          </div>

          <h2 className="text-2xl font-bold text-slate-900">{driverInfo.first_name} {driverInfo.last_name}</h2>
          <p className="text-sm text-slate-500 font-medium mb-6">DNI: {driverInfo.document_number}</p>

          <div className="w-full space-y-4">
            <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-100">
              <div className="p-2 bg-blue-100 text-[#002855] rounded-lg">
                <Truck className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <p className="text-xs text-slate-500 font-medium">Licencia</p>
                <p className="text-sm font-semibold text-slate-800">{driverInfo.license}</p>
              </div>
            </div>

            <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-100">
              <div className="p-2 bg-green-100 text-green-700 rounded-lg">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <p className="text-xs text-slate-500 font-medium">Estado de Cuenta</p>
                <p className="text-sm font-semibold text-slate-800">Verificado</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Menú de Configuración */}
      <div className="px-4 mt-6 mb-20 space-y-3">
        <h3 className="text-sm font-bold text-slate-800 px-2 mb-3 uppercase tracking-wider">Ajustes</h3>
        
        <button className="w-full bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center justify-between hover:bg-slate-50 transition-colors">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center text-slate-600">
              <User className="w-5 h-5" />
            </div>
            <div className="text-left">
              <p className="font-semibold text-slate-800 text-sm">Editar Datos</p>
              <p className="text-xs text-slate-500">Actualiza tu teléfono u otra información</p>
            </div>
          </div>
          <ChevronRight className="w-5 h-5 text-slate-400" />
        </button>
        
        <button 
          onClick={handleLogout}
          className="w-full bg-red-50 p-4 rounded-xl border border-red-100 flex items-center justify-between hover:bg-red-100 transition-colors mt-6"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center text-red-600">
              <LogOut className="w-5 h-5" />
            </div>
            <div className="text-left">
              <p className="font-bold text-red-600 text-sm">Cerrar Sesión</p>
              <p className="text-xs text-red-400">Salir de tu cuenta en este dispositivo</p>
            </div>
          </div>
        </button>
      </div>
    </div>
  )
}
