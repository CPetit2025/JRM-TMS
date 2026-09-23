"use client"

import { User, ChevronRight, ShieldCheck, Phone, Truck, CalendarClock } from 'lucide-react'
import { useActiveTrip } from '@/contexts/ActiveTripContext'

export default function PerfilPage() {
  const { user, driver, trip } = useActiveTrip()
  const driverInfo = {
    first_name: driver?.first_name || user?.first_name || '', last_name: driver?.last_name || user?.last_name || '',
    document_number: driver?.document_number || '', phone: driver?.phone || user?.phone || null,
    license: driver?.license_number || null,
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
                <p className="text-sm font-semibold text-slate-800">{driverInfo.license || 'Pendiente de completar'}</p>
                {driver?.license_category && <p className="text-xs text-slate-500">Categoría {driver.license_category}</p>}
              </div>
            </div>

            <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-100">
              <div className="p-2 bg-emerald-100 text-emerald-700 rounded-lg"><Phone className="w-5 h-5" /></div>
              <div className="flex-1"><p className="text-xs text-slate-500 font-medium">Celular</p><p className="text-sm font-semibold text-slate-800">{driverInfo.phone || 'Pendiente de completar'}</p></div>
            </div>

            <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-100">
              <div className="p-2 bg-amber-100 text-amber-700 rounded-lg"><CalendarClock className="w-5 h-5" /></div>
              <div className="flex-1"><p className="text-xs text-slate-500 font-medium">Vencimiento de licencia</p><p className="text-sm font-semibold text-slate-800">{driver?.license_expiration ? new Date(driver.license_expiration).toLocaleDateString('es-PE') : 'Pendiente de completar'}</p></div>
            </div>

            {trip && <div className="flex items-center gap-3 p-3 bg-blue-50 rounded-xl border border-blue-100">
              <div className="p-2 bg-blue-100 text-[#002855] rounded-lg"><Truck className="w-5 h-5" /></div>
              <div className="flex-1"><p className="text-xs text-slate-500 font-medium">Unidad asignada</p><p className="text-sm font-semibold text-slate-800">{trip.vehicle_plate || 'Pendiente'}</p></div>
            </div>}

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
        
        <button 
          onClick={() => {
            import('sonner').then(({ toast }) => {
              toast.info('Para editar tus datos personales, por favor comunícate con el supervisor de base o soporte de JRM.')
            })
          }}
          className="w-full bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center justify-between hover:bg-slate-50 transition-colors"
        >
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
        
      </div>
    </div>
  )
}
