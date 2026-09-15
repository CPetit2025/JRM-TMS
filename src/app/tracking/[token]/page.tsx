'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Truck, MapPin, Package, Clock, ShieldCheck, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

export default function TrackingPage() {
  const { token } = useParams()
  const [pin, setPin] = useState('')
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [trackingData, setTrackingData] = useState<any>(null)
  
  const supabase = createClient()

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pin.length !== 4) {
      toast.error('El PIN debe ser de 4 dígitos')
      return
    }

    setIsLoading(true)
    try {
      const { data, error } = await supabase.rpc('get_public_daily_tracking_info', {
        p_token: token,
        p_pin: pin
      })

      if (error) throw error

      setTrackingData(data)
      setIsAuthenticated(true)
      toast.success('Acceso autorizado')
    } catch (err: any) {
      toast.error('PIN incorrecto, enlace expirado o inválido.')
      console.error(err)
    } finally {
      setIsLoading(false)
    }
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col justify-center items-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
          <div className="flex flex-col items-center justify-center mb-6">
            <img src="/logo-jrm.png" alt="JRM Logo" className="h-12 mb-4 object-contain drop-shadow-sm" />
            <div className="w-16 h-16 bg-blue-100 text-blue-600 rounded-2xl flex items-center justify-center">
              <ShieldCheck className="w-8 h-8" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-center text-slate-800 mb-2">Seguimiento de Planificación</h1>
          <p className="text-center text-slate-500 mb-8">
            Ingrese el PIN de 4 dígitos que le fue enviado por correo para visualizar el estado de todas las rutas del día.
          </p>
          
          <form onSubmit={handleAuth} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2 text-center">
                Código de Acceso
              </label>
              <input
                type="text"
                maxLength={4}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                className="w-full text-center text-3xl tracking-widest p-4 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                placeholder="••••"
                required
              />
            </div>
            
            <button
              type="submit"
              disabled={isLoading || pin.length !== 4}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white p-4 rounded-xl font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Ver Planificación'}
            </button>
          </form>
          
          <p className="text-center text-xs text-slate-400 mt-8">
            Los enlaces de seguimiento expiran por seguridad después de 24 horas.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-12">
      {/* Header Público */}
      <div className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center gap-3">
              <img src="/logo-jrm.png" alt="JRM" className="h-8 object-contain" />
              <div className="h-6 w-px bg-slate-300"></div>
              <Truck className="w-5 h-5 text-blue-600" />
              <span className="font-bold text-lg text-slate-800">Seguimiento de Planificación</span>
            </div>
            <div className="px-3 py-1 bg-blue-50 text-blue-700 rounded-full text-sm font-medium border border-blue-200">
              {trackingData.planning_date ? new Date(`${trackingData.planning_date}T00:00:00`).toLocaleDateString('es-PE') : 'Fecha'}
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 mt-8 space-y-6">
        {/* Alerta de GPS */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex gap-3">
          <Clock className="w-5 h-5 text-amber-500 shrink-0" />
          <div className="text-sm text-amber-800">
            <span className="font-semibold block mb-1">Nota sobre Monitoreo GPS:</span>
            El monitoreo en tiempo real puede presentar ligeras latencias o discrepancias dependiendo de la cobertura de red móvil en la zona de tránsito del vehículo.
          </div>
        </div>

        {/* Lista de Despachos del día */}
        <h2 className="text-xl font-bold text-slate-800 pt-4 border-b border-slate-200 pb-2">
          Unidades en Ruta ({trackingData.dispatches?.length || 0})
        </h2>

        {(!trackingData.dispatches || trackingData.dispatches.length === 0) ? (
          <div className="text-center py-12 bg-white rounded-xl border border-dashed border-slate-300">
            <p className="text-slate-500">No hay unidades programadas para esta fecha.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {trackingData.dispatches.map((dispatch: any) => (
              <div key={dispatch.id} className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                <div className="bg-slate-50 border-b border-slate-200 p-4 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <h3 className="font-bold text-lg text-[#002855]">Despacho {dispatch.dispatch_number}</h3>
                    <div className="flex flex-wrap items-center gap-4 mt-2 text-sm text-slate-600">
                      <div className="flex items-center gap-1.5">
                        <Truck className="w-4 h-4 text-slate-400" />
                        <span className="font-medium">{dispatch.vehicle_plate || 'Sin asignar'}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <ShieldCheck className="w-4 h-4 text-slate-400" />
                        <span className="font-medium">{dispatch.driver_name || 'Sin asignar'}</span>
                      </div>
                    </div>
                  </div>
                  <div className="px-3 py-1.5 bg-green-100 text-green-700 rounded-full text-sm font-bold border border-green-200 text-center w-fit">
                    {dispatch.status}
                  </div>
                </div>

                {/* Órdenes Asociadas a este despacho */}
                <div className="p-4 sm:p-6">
                  <h4 className="text-sm font-semibold text-slate-800 flex items-center gap-2 mb-4">
                    <Package className="w-4 h-4 text-slate-500" />
                    Entregas Programadas ({dispatch.requests?.length || 0})
                  </h4>
                  
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {dispatch.requests && dispatch.requests.map((req: any) => (
                      <div key={req.id} className="bg-slate-50 rounded-lg p-4 border border-slate-200 relative overflow-hidden group">
                        <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue-500"></div>
                        <div className="flex justify-between items-start mb-3">
                          <span className="font-bold text-slate-900 text-sm">
                            {req.request_number}
                          </span>
                          <span className="text-[10px] bg-white text-slate-600 px-2 py-0.5 rounded border border-slate-200 font-semibold uppercase">
                            {req.status}
                          </span>
                        </div>
                        
                        <div className="space-y-3">
                          <div className="flex gap-2 items-start">
                            <MapPin className="w-3.5 h-3.5 text-slate-400 mt-0.5 shrink-0" />
                            <div>
                              <p className="text-[10px] uppercase font-bold text-slate-400">Origen</p>
                              <p className="text-xs font-medium text-slate-700 line-clamp-1" title={req.pickup_address}>
                                {req.pickup_address}
                              </p>
                            </div>
                          </div>
                          <div className="flex gap-2 items-start">
                            <MapPin className="w-3.5 h-3.5 text-blue-500 mt-0.5 shrink-0" />
                            <div>
                              <p className="text-[10px] uppercase font-bold text-slate-400">Destino</p>
                              <p className="text-xs font-medium text-slate-700 line-clamp-2" title={req.delivery_address}>
                                {req.delivery_address}
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  {(!dispatch.requests || dispatch.requests.length === 0) && (
                    <p className="text-sm text-slate-400 italic">No hay rutas asociadas a este vehículo.</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
