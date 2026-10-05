'use client'

import { useState, useEffect, useMemo } from 'react'
import { useParams } from 'next/navigation'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { Truck, Clock, ShieldCheck, Loader2, Navigation, Layers } from 'lucide-react'
import { toast } from 'sonner'
import { DeliveryTable } from '@/components/delivery/DeliveryTable'
import type { DeliveryRow } from '@/lib/delivery'

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
  status: 'en_ruta' | 'detenido' | 'incidencia' | 'ubicacion'
  speed: number | null
  lat: number
  lng: number
  lastUpdate: string
}

export default function TrackingPage() {
  const { token } = useParams()
  const [pin, setPin] = useState('')
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [trackingData, setTrackingData] = useState<{ planning_date: string; rows: DeliveryRow[] } | null>(null)
  const [activeTab, setActiveTab] = useState<'list' | 'map'>('list')
  const [vehicles, setVehicles] = useState<VehicleLocation[]>([])
  
  const supabase = useMemo(() => createClient(), [])
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState('')
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!isAuthenticated) return
    let cancelled = false
    const load = async () => {
      const { data, error } = await supabase.rpc('get_public_daily_tracking_info', { p_token: token, p_pin: pin })
      if (cancelled) return
      if (error) {
        if (/PIN|vencido|no válido/i.test(error.message)) { setIsAuthenticated(false); setTrackingData(null); setVehicles([]) }
        else setRefreshError('No se pudo actualizar el seguimiento.')
        return
      }
      setTrackingData(data); setUpdatedAt(new Date().toISOString()); setRefreshError('')
    }
    void load(); const timer = window.setInterval(load, 15000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [isAuthenticated, token, pin, supabase, version])

  useEffect(() => {
    if (!isAuthenticated || activeTab !== 'map') return
    let cancelled = false
    const refresh = async () => {
      const { data, error } = await supabase.rpc('get_public_daily_tracking_locations', {
        p_token: token, p_pin: pin
      })
      if (cancelled || error) return
      setVehicles((data || []).map((point: { dispatch_id: string; vehicle_plate?: string; driver_name?: string; lat: number; lng: number; last_gps_at: string }) => ({
        id: point.dispatch_id, plate: point.vehicle_plate || 'Sin placa',
        driver: point.driver_name || 'Conductor', status: 'ubicacion', speed: null,
        lat: Number(point.lat), lng: Number(point.lng),
        lastUpdate: new Date(point.last_gps_at).toLocaleTimeString('es-PE', { timeZone: 'America/Lima' })
      })))
    }
    void refresh()
    const timer = window.setInterval(refresh, 15000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [isAuthenticated, activeTab, token, pin, supabase])

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pin.length !== 4 && pin.length !== 8) {
      toast.error('El PIN debe ser de 8 dígitos (o 4 para enlaces anteriores)')
      return
    }

    setIsLoading(true)
    try {
      const { data, error } = await supabase.rpc('get_public_daily_tracking_info', {
        p_token: token,
        p_pin: pin
      })

      if (error) throw error

      setTrackingData(data); setUpdatedAt(new Date().toISOString()); setRefreshError('')
      setIsAuthenticated(true)
      toast.success('Acceso autorizado')
    } catch (err) {
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
            Ingrese el PIN recibido para visualizar el estado de todas las rutas del día.
          </p>
          
          <form onSubmit={handleAuth} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2 text-center">
                Código de Acceso
              </label>
              <input
                type="text"
                maxLength={8}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                className="w-full text-center text-3xl tracking-widest p-4 border border-slate-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                placeholder="••••"
                required
              />
            </div>
            
            <button
              type="submit"
              disabled={isLoading || (pin.length !== 4 && pin.length !== 8)}
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
        <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center min-h-16 gap-2 py-3">
            <div className="flex items-center gap-3">
              <img src="/logo-jrm.png" alt="JRM" className="h-8 object-contain" />
              <div className="h-6 w-px bg-slate-300"></div>
              <Truck className="w-5 h-5 text-blue-600" />
              <span className="font-bold text-sm sm:text-lg text-slate-800">Seguimiento de Planificación</span>
            </div>
            <div className="px-3 py-1 bg-blue-50 text-blue-700 rounded-full text-sm font-medium border border-blue-200">
              {trackingData?.planning_date ? new Date(`${trackingData?.planning_date}T00:00:00`).toLocaleDateString('es-PE') : 'Fecha'}
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

      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 mt-8 space-y-6">
        {/* Alerta de GPS */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex gap-3">
          <Clock className="w-5 h-5 text-amber-500 shrink-0" />
          <div className="text-sm text-amber-800">
            <span className="font-semibold block mb-1">Nota sobre Monitoreo GPS:</span>
            El monitoreo en tiempo real puede presentar ligeras latencias o discrepancias dependiendo de la cobertura de red móvil en la zona de tránsito del vehículo.
          </div>
        </div>

        {activeTab === 'list' ? (
          <DeliveryTable rows={trackingData?.rows || []} error={refreshError} refreshedAt={updatedAt} onRefresh={() => setVersion(v => v + 1)} />
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
