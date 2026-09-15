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
      const { data, error } = await supabase.rpc('get_public_tracking_info', {
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
          <h1 className="text-2xl font-bold text-center text-slate-800 mb-2">Portal de Seguimiento</h1>
          <p className="text-center text-slate-500 mb-8">
            Ingrese el PIN de 4 dígitos que le fue enviado por correo para visualizar el estado de la ruta.
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
              {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Ver Despacho'}
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
              <span className="font-bold text-lg text-slate-800">Seguimiento</span>
            </div>
            <div className="px-3 py-1 bg-green-100 text-green-700 rounded-full text-sm font-medium">
              {trackingData.status}
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

        {/* Resumen del Despacho */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <h2 className="text-lg font-semibold text-slate-800 mb-4 border-b pb-4">Detalles del Despacho {trackingData.dispatch_number}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <p className="text-sm text-slate-500 mb-1">Conductor Asignado</p>
              <p className="font-medium text-slate-800">{trackingData.driver_name || 'Por asignar'}</p>
            </div>
            <div>
              <p className="text-sm text-slate-500 mb-1">Vehículo / Placa</p>
              <p className="font-medium text-slate-800">{trackingData.vehicle_plate || 'Por asignar'}</p>
            </div>
            <div>
              <p className="text-sm text-slate-500 mb-1">Salida Programada</p>
              <p className="font-medium text-slate-800">
                {trackingData.scheduled_departure ? new Date(trackingData.scheduled_departure).toLocaleString('es-PE') : 'Pendiente'}
              </p>
            </div>
            <div>
              <p className="text-sm text-slate-500 mb-1">Distancia Estimada</p>
              <p className="font-medium text-slate-800">{trackingData.estimated_distance_km || 0} km</p>
            </div>
          </div>
        </div>

        {/* Órdenes Asociadas */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-6 border-b border-slate-200">
            <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
              <Package className="w-5 h-5 text-slate-500" />
              Entregas Programadas
            </h2>
          </div>
          <div className="divide-y divide-slate-100">
            {trackingData.requests && trackingData.requests.map((req: any, i: number) => (
              <div key={req.id} className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <span className="font-medium text-slate-800">Orden: {req.request_number}</span>
                  <span className="text-sm bg-slate-100 text-slate-600 px-2 py-1 rounded-md">{req.status}</span>
                </div>
                
                <div className="relative pl-6 space-y-6">
                  <div className="absolute left-2.5 top-2 bottom-2 w-0.5 bg-slate-200"></div>
                  
                  <div className="relative">
                    <div className="absolute -left-6 top-1 w-3 h-3 bg-white border-2 border-slate-300 rounded-full"></div>
                    <p className="text-xs font-medium text-slate-500 mb-1 uppercase tracking-wider">Origen</p>
                    <p className="text-sm text-slate-800">{req.pickup_address}</p>
                  </div>
                  
                  <div className="relative">
                    <div className="absolute -left-6 top-1 w-3 h-3 bg-blue-600 rounded-full shadow-[0_0_0_4px_rgba(37,99,235,0.1)]"></div>
                    <p className="text-xs font-medium text-blue-600 mb-1 uppercase tracking-wider">Destino</p>
                    <p className="text-sm text-slate-800">{req.delivery_address}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
