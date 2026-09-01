"use client"

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { Truck, Search, AlertCircle, Navigation, MapPin, Activity, Radio, Layers, Eye, EyeOff, AlertTriangle, CheckCircle2, Clock } from 'lucide-react'

const MapComponent = dynamic(() => import('@/components/map/MapComponent'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full bg-slate-100 flex flex-col items-center justify-center text-slate-400 rounded-xl border border-slate-200">
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

export default function MonitoreoPage() {
  const [vehicles, setVehicles] = useState<VehicleLocation[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null)
  const [showGeofences, setShowGeofences] = useState(true)
  const [filterStatus, setFilterStatus] = useState<'all' | 'en_ruta' | 'detenido' | 'incidencia'>('all')
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date())

  useEffect(() => {
    let supabase: any = null
    let channel: any = null

    const setupRealtime = async () => {
      supabase = await import('@/lib/supabase/client').then(m => m.createClient())

      channel = supabase.channel('gps_tracking')
        .on('broadcast', { event: 'location_update' }, (payload: any) => {
          const data = payload.payload
          setLastRefresh(new Date())
          setVehicles(prev => {
            const exists = prev.find(v => v.id === data.driver_id)
            const newStatus: 'en_ruta' | 'detenido' | 'incidencia' = 'en_ruta'
            if (exists) {
              return prev.map(v => v.id === exists.id ? {
                ...v,
                lat: data.lat,
                lng: data.lng,
                speed: data.speed || 0,
                status: newStatus,
                lastUpdate: 'En vivo'
              } : v)
            } else {
              return [{
                id: data.driver_id,
                plate: 'EN-RUTA',
                driver: data.driver_name,
                status: newStatus,
                speed: data.speed || 0,
                lat: data.lat,
                lng: data.lng,
                lastUpdate: 'En vivo'
              }, ...prev]
            }
          })
        })
        .subscribe()
    }

    setupRealtime()
    return () => { if (channel) supabase.removeChannel(channel) }
  }, [])

  const activeCount = vehicles.filter(v => v.status === 'en_ruta').length
  const stoppedCount = vehicles.filter(v => v.status === 'detenido').length
  const issueCount = vehicles.filter(v => v.status === 'incidencia').length

  const filteredVehicles = vehicles.filter(v => {
    const matchSearch = v.plate.toLowerCase().includes(searchTerm.toLowerCase()) ||
      v.driver.toLowerCase().includes(searchTerm.toLowerCase())
    const matchFilter = filterStatus === 'all' || v.status === filterStatus
    return matchSearch && matchFilter
  })

  const selectedVehicle = vehicles.find(v => v.id === selectedVehicleId)

  return (
    <div className="h-[calc(100vh-2rem)] flex flex-col gap-3">
      
      {/* Header con KPIs */}
      <div className="flex items-center justify-between bg-white px-5 py-3 rounded-xl shadow-sm border border-slate-200 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-[#002855] rounded-lg flex items-center justify-center">
            <Navigation className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-black text-slate-800 leading-tight">Monitoreo GPS</h1>
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
              <p className="text-xs text-slate-500">Seguimiento en tiempo real de la flota operativa</p>
            </div>
          </div>
        </div>

        <div className="flex gap-3">
          {/* KPI: En Ruta */}
          <div className="bg-green-50 border border-green-200 px-4 py-2 rounded-xl flex items-center gap-3">
            <div className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse" />
            <div>
              <p className="text-[10px] text-green-700 font-bold uppercase tracking-wide">En Ruta</p>
              <p className="text-2xl font-black text-green-800 leading-none">{activeCount}</p>
            </div>
          </div>

          {/* KPI: Detenidos */}
          <div className="bg-orange-50 border border-orange-200 px-4 py-2 rounded-xl flex items-center gap-3">
            <div className="w-2.5 h-2.5 rounded-full bg-orange-500" />
            <div>
              <p className="text-[10px] text-orange-700 font-bold uppercase tracking-wide">Detenidos</p>
              <p className="text-2xl font-black text-orange-800 leading-none">{stoppedCount}</p>
            </div>
          </div>

          {/* KPI: Incidencias */}
          <div className={`border px-4 py-2 rounded-xl flex items-center gap-3 ${issueCount > 0 ? 'bg-red-50 border-red-300' : 'bg-slate-50 border-slate-200'}`}>
            <div className={`w-2.5 h-2.5 rounded-full ${issueCount > 0 ? 'bg-red-500 animate-pulse' : 'bg-slate-400'}`} />
            <div>
              <p className={`text-[10px] font-bold uppercase tracking-wide ${issueCount > 0 ? 'text-red-700' : 'text-slate-500'}`}>Incidencias</p>
              <p className={`text-2xl font-black leading-none ${issueCount > 0 ? 'text-red-800' : 'text-slate-600'}`}>{issueCount}</p>
            </div>
          </div>

          {/* Última actualización */}
          <div className="bg-slate-50 border border-slate-200 px-4 py-2 rounded-xl flex items-center gap-2">
            <Clock className="w-4 h-4 text-slate-400" />
            <div>
              <p className="text-[10px] text-slate-500 font-medium">Última señal</p>
              <p className="text-xs font-bold text-slate-700">
                {lastRefresh.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex gap-3 min-h-0">

        {/* Panel Lateral — Lista de Flota */}
        <div className="w-72 bg-white rounded-xl shadow-sm border border-slate-200 flex flex-col shrink-0 overflow-hidden">
          
          {/* Search + Filter */}
          <div className="p-3 border-b border-slate-100 bg-slate-50 space-y-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-400" />
              <input
                type="text"
                placeholder="Buscar placa o conductor..."
                className="w-full pl-8 pr-3 py-2 bg-white text-slate-900 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#002855]"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            
            {/* Filter tabs */}
            <div className="flex gap-1">
              {[
                { key: 'all', label: 'Todos', count: vehicles.length },
                { key: 'en_ruta', label: 'Ruta', count: activeCount },
                { key: 'incidencia', label: 'Alertas', count: issueCount },
              ].map(f => (
                <button
                  key={f.key}
                  onClick={() => setFilterStatus(f.key as any)}
                  className={`flex-1 py-1 text-[10px] font-bold rounded-md transition-colors ${
                    filterStatus === f.key
                      ? 'bg-[#002855] text-white'
                      : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {f.label} {f.count > 0 && <span className="opacity-70">({f.count})</span>}
                </button>
              ))}
            </div>
          </div>

          {/* Vehicle list */}
          <div className="flex-1 overflow-y-auto divide-y divide-slate-50">
            {filteredVehicles.length === 0 ? (
              <div className="p-8 text-center text-slate-400">
                <Radio className="w-8 h-8 mx-auto mb-3 opacity-30" />
                <p className="text-sm font-medium">Sin señal GPS</p>
                <p className="text-xs mt-1 opacity-70">
                  {vehicles.length === 0
                    ? 'Esperando conexión de conductores'
                    : 'No coincide con la búsqueda'}
                </p>
              </div>
            ) : (
              filteredVehicles.map(vehicle => (
                <div
                  key={vehicle.id}
                  onClick={() => setSelectedVehicleId(vehicle.id === selectedVehicleId ? null : vehicle.id)}
                  className={`p-3 cursor-pointer transition-all ${
                    selectedVehicleId === vehicle.id
                      ? 'bg-blue-50 border-l-4 border-l-[#002855]'
                      : 'hover:bg-slate-50 border-l-4 border-l-transparent'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center ${
                        vehicle.status === 'en_ruta' && vehicle.speed > 5 ? 'bg-green-100' :
                        vehicle.status === 'incidencia' ? 'bg-red-100' : 'bg-orange-100'
                      }`}>
                        <Truck className={`w-3.5 h-3.5 ${
                          vehicle.status === 'en_ruta' && vehicle.speed > 5 ? 'text-green-600' :
                          vehicle.status === 'incidencia' ? 'text-red-600' : 'text-orange-500'
                        }`} />
                      </div>
                      <div>
                        <p className="text-xs font-bold text-slate-800">{vehicle.plate}</p>
                        <p className="text-[10px] text-slate-500">{vehicle.driver}</p>
                      </div>
                    </div>
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                      vehicle.status === 'en_ruta' && vehicle.speed > 5 ? 'bg-green-100 text-green-700' :
                      vehicle.status === 'en_ruta' ? 'bg-yellow-100 text-yellow-700' :
                      vehicle.status === 'incidencia' ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'
                    }`}>
                      {vehicle.status === 'en_ruta' && vehicle.speed > 5 ? 'MOVIMIENTO' :
                       vehicle.status === 'en_ruta' ? 'RALENTÍ' :
                       vehicle.status === 'incidencia' ? '⚠ ALERTA' : 'DETENIDO'}
                    </span>
                  </div>

                  <div className="flex justify-between text-[10px] text-slate-500 pl-9">
                    <span className="flex items-center gap-1">
                      <Activity className="w-3 h-3" />
                      {vehicle.speed} km/h
                    </span>
                    <span className="flex items-center gap-1">
                      <MapPin className="w-3 h-3" />
                      {vehicle.lastUpdate}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Layer controls */}
          <div className="p-3 border-t border-slate-100 bg-slate-50 space-y-2">
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wide flex items-center gap-1.5">
              <Layers className="w-3 h-3" /> Capas del Mapa
            </p>
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-600 font-medium">Geocercas</span>
              <button
                onClick={() => setShowGeofences(!showGeofences)}
                className={`w-10 h-5 rounded-full transition-colors relative ${showGeofences ? 'bg-[#002855]' : 'bg-slate-300'}`}
              >
                <div className={`w-4 h-4 bg-white rounded-full absolute top-0.5 transition-all shadow-sm ${showGeofences ? 'left-5' : 'left-0.5'}`} />
              </button>
            </div>
          </div>
        </div>

        {/* Map area */}
        <div className="flex-1 relative rounded-xl overflow-hidden">
          <MapComponent
            vehicles={vehicles}
            selectedVehicleId={selectedVehicleId}
            onVehicleSelect={setSelectedVehicleId}
            showGeofences={showGeofences}
          />

          {/* Selected vehicle detail overlay */}
          {selectedVehicle && (
            <div className="absolute bottom-4 left-4 bg-white rounded-xl shadow-xl border border-slate-200 p-4 min-w-[260px] z-[500]">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className={`w-3 h-3 rounded-full ${
                    selectedVehicle.status === 'en_ruta' && selectedVehicle.speed > 5 ? 'bg-green-500 animate-pulse' :
                    selectedVehicle.status === 'incidencia' ? 'bg-red-500 animate-pulse' : 'bg-orange-500'
                  }`} />
                  <span className="font-black text-[#002855] text-lg">{selectedVehicle.plate}</span>
                </div>
                <button
                  onClick={() => setSelectedVehicleId(null)}
                  className="text-slate-400 hover:text-slate-600 text-lg leading-none"
                >×</button>
              </div>
              <p className="text-sm text-slate-600 mb-3">
                <span className="font-medium">Conductor:</span> {selectedVehicle.driver}
              </p>
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-slate-50 rounded-lg p-2 text-center">
                  <p className="text-[9px] text-slate-400 font-bold uppercase">Velocidad</p>
                  <p className="text-xl font-black text-slate-800">{selectedVehicle.speed}</p>
                  <p className="text-[9px] text-slate-400">km/h</p>
                </div>
                <div className="bg-slate-50 rounded-lg p-2 text-center">
                  <p className="text-[9px] text-slate-400 font-bold uppercase">Estado</p>
                  <p className={`text-xs font-black mt-1 ${
                    selectedVehicle.status === 'en_ruta' ? 'text-green-600' :
                    selectedVehicle.status === 'incidencia' ? 'text-red-600' : 'text-orange-500'
                  }`}>
                    {selectedVehicle.speed > 5 ? 'MOVIMIENTO' : selectedVehicle.status === 'en_ruta' ? 'RALENTÍ' : 'DETENIDO'}
                  </p>
                </div>
                <div className="bg-slate-50 rounded-lg p-2 text-center">
                  <p className="text-[9px] text-slate-400 font-bold uppercase">Señal</p>
                  <p className="text-xs font-bold text-green-600 mt-1">{selectedVehicle.lastUpdate}</p>
                </div>
              </div>
              <p className="text-[9px] text-slate-400 text-center mt-2">
                📍 {selectedVehicle.lat.toFixed(5)}, {selectedVehicle.lng.toFixed(5)}
              </p>
            </div>
          )}

          {/* Geocercas legend */}
          {showGeofences && (
            <div className="absolute top-4 right-4 bg-white/95 backdrop-blur-sm rounded-xl shadow-lg border border-slate-200 p-3 z-[400]">
              <p className="text-[10px] font-bold text-slate-600 uppercase tracking-wide mb-2">Geocercas</p>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-sm bg-blue-400/60 border border-blue-500" />
                  <span className="text-[10px] text-slate-600">CEDI - Callao</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-sm bg-amber-400/60 border border-amber-500" />
                  <span className="text-[10px] text-slate-600">Depot B - SJL</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-sm bg-emerald-400/60 border border-emerald-500" />
                  <span className="text-[10px] text-slate-600">Zona Dist. - Ate</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
