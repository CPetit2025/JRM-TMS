'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { Truck, MapPin, Package, Clock, ShieldCheck, Loader2, Navigation, Layers } from 'lucide-react'
import { toast } from 'sonner'

const MapComponent = dynamic(() => import('@/components/map/MapComponent'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full min-h-[400px] bg-slate-100 flex flex-col items-center justify-center text-slate-400 rounded-xl border border-slate-200">
      <div className="w-10 h-10 border-4 border-[#002855] border-t-transparent rounded-full animate-spin mb-4"></div>
      <p className="font-medium">Cargando mapa en tiempo real...</p>
    </div>
  )
})

interface VehicleLocation {
  id: string
  plate: string
  driver: string
  status: 'en_ruta' | 'detenido' | 'incidencia'
  speed: number
  lat: number
  lng: number
  lastUpdate: string
}
import { toast } from 'sonner'

export default function TrackingPage() {
  const { token } = useParams()
  const [pin, setPin] = useState('')
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [trackingData, setTrackingData] = useState<any>(null)
  const [activeTab, setActiveTab] = useState<'list' | 'map'>('list')
  const [vehicles, setVehicles] = useState<VehicleLocation[]>([])
  
  const supabase = createClient()

  useEffect(() => {
    if (!isAuthenticated || activeTab !== 'map') return

    const channel = supabase.channel('gps_tracking')
      .on('broadcast', { event: 'location_update' }, (payload: any) => {
        const data = payload.payload
        setVehicles(prev => {
          const exists = prev.find(v => v.id === data.driver_id)
          const newStatus: 'en_ruta' | 'detenido' | 'incidencia' = 'en_ruta'
          if (exists) {
            return prev.map(v => v.id === exists.id ? {
              ...v, lat: data.lat, lng: data.lng, speed: data.speed || 0, status: newStatus, lastUpdate: 'En vivo'
            } : v)
          } else {
            return [{
              id: data.driver_id, plate: 'EN-RUTA', driver: data.driver_name, status: newStatus,
              speed: data.speed || 0, lat: data.lat, lng: data.lng, lastUpdate: 'En vivo'
            }, ...prev]
          }
        })
      })
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [isAuthenticated, activeTab])

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
          
          {/* Navegación de Pestañas */}
          <div className="flex border-t border-slate-200 mt-2">
            <button
              onClick={() => setActiveTab('list')}
              className={`flex items-center gap-2 px-6 py-4 font-medium text-sm transition-colors border-b-2 ${
                activeTab === 'list'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-300'
              }`}
            >
              <Layers className="w-4 h-4" />
              Torre de Control
            </button>
            <button
              onClick={() => setActiveTab('map')}
              className={`flex items-center gap-2 px-6 py-4 font-medium text-sm transition-colors border-b-2 ${
                activeTab === 'map'
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-300'
              }`}
            >
              <Navigation className="w-4 h-4" />
              Monitoreo GPS
            </button>
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

        {activeTab === 'list' ? (
          <>
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
          </>
        ) : (
          <div className="h-[600px] bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden relative">
            {/* Si no hay vehículos con GPS actualmente, mostrar el mapa igual pero con un overlay o solo el componente */}
            <MapComponent 
              vehicles={vehicles}
              selectedVehicleId={null}
              onVehicleSelect={() => {}}
              showGeofences={false}
            />
            {vehicles.length === 0 && (
              <div className="absolute inset-x-0 bottom-4 mx-auto w-fit bg-slate-900/80 backdrop-blur-sm text-white px-4 py-2 rounded-full text-sm font-medium z-[1000] shadow-lg flex items-center gap-2">
                <Navigation className="w-4 h-4 text-blue-400" />
                Esperando señal GPS de las unidades...
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
