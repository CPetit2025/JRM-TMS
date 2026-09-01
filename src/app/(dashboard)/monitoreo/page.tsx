"use client"

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { Truck, Search, AlertCircle, Navigation, MapPin } from 'lucide-react'

// Carga dinámica del mapa para evitar errores de SSR con Leaflet
const MapComponent = dynamic(() => import('@/components/map/MapComponent'), { 
  ssr: false,
  loading: () => (
    <div className="w-full h-full bg-slate-100 flex flex-col items-center justify-center text-slate-400 rounded-xl border border-slate-200">
      <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
      <p>Cargando mapa en tiempo real...</p>
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

// Quitamos datos mockeados para usar solo los reales
const INITIAL_VEHICLES: VehicleLocation[] = []

export default function MonitoreoPage() {
  const [vehicles, setVehicles] = useState<VehicleLocation[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null)

  // Simular actualización en tiempo real y leer desde el GPS del conductor
  useEffect(() => {
    let supabase: any = null;
    let channel: any = null;

    const setupRealtime = async () => {
      supabase = await import('@/lib/supabase/client').then(m => m.createClient())
      
      channel = supabase.channel('gps_tracking')
        .on('broadcast', { event: 'location_update' }, (payload: any) => {
          const data = payload.payload;
          console.log('Recibida actualización GPS de conductor:', data)
          setVehicles(prev => {
            const exists = prev.find(v => v.id === data.driver_id)
            
            if (exists) {
              return prev.map(v => v.id === exists.id ? {
                ...v,
                lat: data.lat,
                lng: data.lng,
                status: 'en_ruta',
                lastUpdate: 'En vivo'
              } : v)
            } else {
              return [{
                id: data.driver_id,
                plate: 'EN-RUTA',
                driver: data.driver_name,
                status: 'en_ruta',
                speed: 40,
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

    return () => {
      if (channel) supabase.removeChannel(channel)
    }
  }, [])

  const filteredVehicles = vehicles.filter(v => 
    v.plate.toLowerCase().includes(searchTerm.toLowerCase()) || 
    v.driver.toLowerCase().includes(searchTerm.toLowerCase())
  )

  const activeCount = vehicles.filter(v => v.status === 'en_ruta').length
  const stoppedCount = vehicles.filter(v => v.status === 'detenido').length
  const issueCount = vehicles.filter(v => v.status === 'incidencia').length

  return (
    <div className="h-[calc(100vh-2rem)] flex flex-col space-y-4">
      {/* Encabezado y Estadísticas */}
      <div className="flex justify-between items-center bg-white p-4 rounded-xl shadow-sm border border-slate-200 shrink-0">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <Navigation className="w-6 h-6 text-[#002855]" />
            Monitoreo GPS
          </h1>
          <p className="text-sm text-slate-500">Seguimiento en tiempo real de la flota operativa</p>
        </div>
        
        <div className="flex gap-4">
          <div className="bg-slate-50 px-4 py-2 rounded-lg border border-slate-100 flex items-center gap-3 min-w-[120px]">
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
            <div>
              <p className="text-xs text-slate-500 font-medium">En Ruta</p>
              <p className="text-lg font-bold text-slate-800">{activeCount}</p>
            </div>
          </div>
          <div className="bg-slate-50 px-4 py-2 rounded-lg border border-slate-100 flex items-center gap-3 min-w-[120px]">
            <div className="w-2 h-2 rounded-full bg-orange-500"></div>
            <div>
              <p className="text-xs text-slate-500 font-medium">Detenidos</p>
              <p className="text-lg font-bold text-slate-800">{stoppedCount}</p>
            </div>
          </div>
          <div className="bg-slate-50 px-4 py-2 rounded-lg border border-slate-100 flex items-center gap-3 min-w-[120px]">
            <div className="w-2 h-2 rounded-full bg-red-500"></div>
            <div>
              <p className="text-xs text-slate-500 font-medium">Incidencias</p>
              <p className="text-lg font-bold text-slate-800">{issueCount}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Contenido Principal */}
      <div className="flex-1 flex gap-4 min-h-0">
        
        {/* Panel Lateral - Lista de Vehículos */}
        <div className="w-80 bg-white rounded-xl shadow-sm border border-slate-200 flex flex-col shrink-0">
          <div className="p-4 border-b border-slate-100 bg-slate-50 rounded-t-xl">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
              <input 
                type="text" 
                placeholder="Buscar placa o conductor..." 
                className="w-full pl-9 pr-4 py-2 bg-white text-slate-900 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#002855]"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          </div>
          
          <div className="flex-1 overflow-y-auto p-2 space-y-2 custom-scrollbar">
            {filteredVehicles.map(vehicle => (
              <div 
                key={vehicle.id}
                onClick={() => setSelectedVehicleId(vehicle.id)}
                className={`p-3 rounded-lg border cursor-pointer transition-all ${
                  selectedVehicleId === vehicle.id 
                    ? 'border-[#002855] bg-blue-50/50 shadow-sm ring-1 ring-[#002855]/20' 
                    : 'border-slate-100 hover:border-slate-300 hover:bg-slate-50'
                }`}
              >
                <div className="flex justify-between items-start mb-2">
                  <div className="flex items-center gap-2">
                    <Truck className={`w-4 h-4 ${
                      vehicle.status === 'en_ruta' ? 'text-green-600' :
                      vehicle.status === 'detenido' ? 'text-orange-500' :
                      'text-red-500'
                    }`} />
                    <span className="font-bold text-slate-800">{vehicle.plate}</span>
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${
                    vehicle.status === 'en_ruta' ? 'bg-green-100 text-green-700' :
                    vehicle.status === 'detenido' ? 'bg-orange-100 text-orange-700' :
                    'bg-red-100 text-red-700'
                  }`}>
                    {vehicle.status.replace('_', ' ')}
                  </span>
                </div>
                
                <p className="text-xs text-slate-600 font-medium mb-1">{vehicle.driver}</p>
                
                <div className="flex justify-between items-center text-xs text-slate-500 mt-2 pt-2 border-t border-slate-100">
                  <div className="flex items-center gap-1">
                    <Navigation className="w-3 h-3" />
                    <span>{vehicle.speed} km/h</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <MapPin className="w-3 h-3" />
                    <span>{vehicle.lastUpdate}</span>
                  </div>
                </div>
              </div>
            ))}
            
            {filteredVehicles.length === 0 && (
              <div className="text-center p-8 text-slate-500">
                <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No se encontraron vehículos</p>
              </div>
            )}
          </div>
        </div>

        {/* Mapa Interactivo */}
        <div className="flex-1 bg-slate-100 rounded-xl relative">
          <MapComponent 
            vehicles={vehicles} 
            selectedVehicleId={selectedVehicleId} 
            onVehicleSelect={setSelectedVehicleId} 
          />
        </div>
      </div>
    </div>
  )
}
