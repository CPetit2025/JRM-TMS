'use client'

import { useState, useEffect, useMemo } from 'react'
import { useParams } from 'next/navigation'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { Truck, Clock, ShieldCheck, Loader2, Navigation, CalendarDays, Route } from 'lucide-react'
import { toast } from 'sonner'
import { DeliveryTable } from '@/components/delivery/DeliveryTable'
import { TrackingCalendar } from '@/components/tracking/TrackingCalendar'
import { RouteDay } from '@/components/tracking/RouteDay'
import type { PortalRow } from '@/lib/tracking-portal'
import { limaDay, monthDays, type PortalRequest } from '@/lib/tracking-calendar'

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
  const [trackingData, setTrackingData] = useState<{ mode: 'permanent' | 'legacy'; planning_date?: string; rows: PortalRow[]; requests: PortalRequest[]; locations: {dispatch_id:string;dispatch_number?:string;vehicle_plate?:string;driver_name?:string;lat:number;lng:number;last_gps_at:string}[]; error?:string; limited?:boolean } | null>(null)
  const [month, setMonth] = useState(() => limaDay(new Date().toISOString()).slice(0,7))
  const range = useMemo(() => { const days=monthDays(month); return {p_from:days[0],p_to:days[41]} },[month])
  const [activeTab, setActiveTab] = useState<'calendar' | 'route' | 'map'>('calendar')
  const [routeDay, setRouteDay] = useState(() => limaDay(new Date().toISOString()))
  const changeRouteDay = (day: string) => { setRouteDay(day); if (day < range.p_from || day > range.p_to) setMonth(day.slice(0, 7)) }
  const [vehicles, setVehicles] = useState<VehicleLocation[]>([])
  
  const supabase = useMemo(() => createClient(), [])
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState('')
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!isAuthenticated) return
    let cancelled = false
    const load = async () => {
      const { data, error } = await supabase.rpc('get_public_tracking_portal_info', { p_token: token, p_pin: pin, ...range })
      if (cancelled) return
      if (error || data?.error) {
        if (data?.error || /PIN|vencido|no válido/i.test(error?.message || '')) { setIsAuthenticated(false); setTrackingData(null); setVehicles([]) }
        else setRefreshError('No se pudo actualizar el seguimiento.')
        return
      }
      setTrackingData(data); setUpdatedAt(new Date().toISOString()); setRefreshError('')
    }
    void load(); const timer = window.setInterval(load, 15000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [isAuthenticated, token, pin, supabase, version, range])

  useEffect(() => {
    if (!isAuthenticated || activeTab !== 'map') return
    let cancelled = false
    const refresh = async () => {
      const data = trackingData?.locations || []
      if (cancelled) return
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
  }, [isAuthenticated, activeTab, trackingData])

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault()
    if (pin.length !== 4 && pin.length !== 8) {
      toast.error('El PIN debe ser de 8 dígitos (o 4 para enlaces anteriores)')
      return
    }

    setIsLoading(true)
    try {
      const { data, error } = await supabase.rpc('get_public_tracking_portal_info', {
        p_token: token, p_pin: pin, ...range
      })

      if (error) throw error
      if (data?.error) throw new Error(data.error)

      setTrackingData(data); setUpdatedAt(new Date().toISOString()); setRefreshError('')
      setActiveTab(data?.mode === 'permanent' ? 'calendar' : 'route')
      setIsAuthenticated(true)
      toast.success('Acceso autorizado')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'PIN incorrecto, enlace expirado o inválido.')
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
          <h1 className="text-2xl font-bold text-center text-slate-800 mb-2">Planificación y Seguimiento de Transporte</h1>
          <p className="text-center text-slate-500 mb-8">
            Ingrese el código recibido para consultar el calendario y las operaciones autorizadas.
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
            Acceso de consulta protegido. El administrador puede revocarlo o cambiar su código.
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
          <div className="flex flex-col items-stretch justify-between gap-3 py-3 sm:min-h-16 sm:flex-row sm:items-center">
            <div className="flex items-center gap-3">
              <img src="/logo-jrm.png" alt="JRM" className="h-8 shrink-0 object-contain" />
              <div className="hidden h-6 w-px bg-slate-300 sm:block"></div>
              <Truck className="hidden w-5 h-5 text-blue-600 sm:block" />
              <span className="font-bold text-base leading-snug sm:text-lg text-slate-800">Planificación y Seguimiento de Transporte</span>
            </div>
            <div className="flex items-center justify-between gap-2 sm:justify-end"><button className="rounded-lg border px-3 py-2 text-xs text-slate-600" onClick={() => {setIsAuthenticated(false);setPin('');setTrackingData(null);setVehicles([])}}>Salir</button><div className="px-3 py-1 bg-blue-50 text-blue-700 rounded-full text-sm font-medium border border-blue-200">
              {trackingData?.planning_date ? new Date(`${trackingData?.planning_date}T00:00:00`).toLocaleDateString('es-PE') : 'Portal de seguimiento'}
            </div></div>
          </div>
          
          {/* Navegación de Pestañas */}
          <div className="mt-2 flex overflow-x-auto border-t border-slate-200">
            {([
              ...(trackingData?.mode === 'permanent' ? [{ key: 'calendar', label: 'Calendario', icon: CalendarDays }] : []),
              { key: 'route', label: 'Ruta del día', icon: Route },
              { key: 'map', label: 'Monitoreo GPS', icon: Navigation },
            ] as const).map(tab => <button key={tab.key} onClick={() => setActiveTab(tab.key as 'calendar' | 'route' | 'map')}
              className={`flex shrink-0 items-center gap-2 border-b-2 px-3 py-4 text-xs font-medium transition-colors sm:px-6 sm:text-sm ${activeTab === tab.key ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800'}`}>
              <tab.icon className="h-4 w-4" />{tab.label}
            </button>)}
          </div>
        </div>
      </div>

      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 mt-8 space-y-6">
        {/* Alerta de GPS */}
        {activeTab === 'map' && <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex gap-3">
          <Clock className="w-5 h-5 text-amber-500 shrink-0" />
          <div className="text-sm text-amber-800">
            <span className="font-semibold block mb-1">Nota sobre Monitoreo GPS:</span>
            El monitoreo en tiempo real puede presentar ligeras latencias o discrepancias dependiendo de la cobertura de red móvil en la zona de tránsito del vehículo.
          </div>
        </div>}

        {activeTab === 'calendar' && trackingData?.mode === 'permanent' && <div className="space-y-6">
          {trackingData.limited && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Hay más solicitudes. Consulta un período más específico o solicita un acceso acotado.</p>}
          <TrackingCalendar month={month} onMonth={setMonth} requests={trackingData.requests || []} rows={trackingData.rows || []} />
        </div>}
        {(activeTab === 'route' || (activeTab === 'calendar' && trackingData?.mode !== 'permanent')) && (trackingData?.mode === 'permanent'
          ? <RouteDay rows={trackingData.rows || []} day={routeDay} onDay={changeRouteDay} access={{ token: String(token), pin }} refreshedAt={updatedAt} error={refreshError} onRefresh={() => setVersion(v => v + 1)} />
          : <DeliveryTable rows={trackingData?.rows || []} error={refreshError} refreshedAt={updatedAt} onRefresh={() => setVersion(v => v + 1)} />)}
        {activeTab === 'map' && <>
          <div className="h-[600px] bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden relative">
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
          <div className="rounded-xl border border-slate-200 bg-white">
            <p className="border-b px-4 py-3 text-sm font-bold text-[#002855]">Unidades con señal en los últimos 15 minutos · {vehicles.length}</p>
            {vehicles.length ? <ul className="divide-y">{(trackingData?.locations || []).map(point => <li key={point.dispatch_id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
              <span><b>{point.vehicle_plate || 'Sin placa'}</b>{point.dispatch_number ? ` · Ruta ${point.dispatch_number}` : ''} · {point.driver_name || 'Conductor'}</span>
              <span className="text-xs text-slate-500">Última señal {new Date(point.last_gps_at).toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false })}</span>
            </li>)}</ul> : <p className="px-4 py-3 text-sm text-slate-500">Ninguna unidad del alcance autorizado reporta posición ahora. Se muestran las rutas en curso cuyas paradas están todas dentro de este acceso.</p>}
          </div>
        </>}
      </div>
    </div>
  )
}
