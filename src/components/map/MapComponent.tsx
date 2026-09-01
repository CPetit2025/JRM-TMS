"use client"

import { useEffect, useState, useCallback } from 'react'
import { MapContainer, TileLayer, Marker, Popup, ZoomControl, Polygon, Circle, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Fix default icon
delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
})

// Geocercas - se cargan dinámicamente desde Supabase
interface GeofenceData {
  id: string
  name: string
  color: string
  coordinates: [number, number][]
  is_active: boolean
}

// Create directional truck icon based on status and speed
function createTruckIcon(status: string, speed: number) {
  const color = status === 'en_ruta' && speed > 5
    ? '#16A34A'   // verde - en movimiento
    : status === 'en_ruta' && speed <= 5
    ? '#F59E0B'   // amarillo - ralentí
    : status === 'incidencia'
    ? '#DC2626'   // rojo - incidencia
    : '#EA580C'   // naranja - detenido

  const pulse = status === 'incidencia'
    ? `animation: pulse-red 1.5s infinite;`
    : status === 'en_ruta' && speed > 5
    ? `animation: pulse-green 2s infinite;`
    : ''

  return L.divIcon({
    className: 'custom-truck-icon',
    html: `
      <div style="position: relative; width: 42px; height: 42px;">
        <div style="
          background-color: ${color};
          width: 40px; height: 40px; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          border: 3px solid white;
          box-shadow: 0 4px 12px rgba(0,0,0,0.35);
          position: relative;
          ${pulse}
        ">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M10 17h4V5H2v12h3"/>
            <path d="M20 17h2v-9h-5V5h-7"/>
            <path d="M15 9h4"/>
            <circle cx="7.5" cy="17.5" r="2.5"/>
            <circle cx="17.5" cy="17.5" r="2.5"/>
          </svg>
        </div>
        ${speed > 5 ? `
          <div style="
            position: absolute; bottom: -4px; left: 50%; transform: translateX(-50%);
            background: ${color}; color: white; font-size: 8px; font-weight: 800;
            padding: 1px 4px; border-radius: 4px; white-space: nowrap;
            border: 1px solid rgba(255,255,255,0.5);
          ">${speed} km/h</div>
        ` : ''}
      </div>
    `,
    iconSize: [42, 50],
    iconAnchor: [21, 42],
    popupAnchor: [0, -45],
  })
}

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

interface MapComponentProps {
  vehicles: VehicleLocation[]
  selectedVehicleId: string | null
  onVehicleSelect: (id: string) => void
  showGeofences: boolean
}

// Helper component to fly to selected vehicle
function FlyToVehicle({ vehicles, selectedVehicleId }: { vehicles: VehicleLocation[], selectedVehicleId: string | null }) {
  const map = useMap()
  useEffect(() => {
    if (selectedVehicleId) {
      const vehicle = vehicles.find(v => v.id === selectedVehicleId)
      if (vehicle) {
        map.flyTo([vehicle.lat, vehicle.lng], 16, { animate: true, duration: 1.2 })
      }
    }
  }, [map, selectedVehicleId, vehicles])
  return null
}

export default function MapComponent({ vehicles, selectedVehicleId, onVehicleSelect, showGeofences }: MapComponentProps) {
  const defaultCenter: [number, number] = [-12.0464, -77.0428]
  const [geofences, setGeofences] = useState<GeofenceData[]>([])

  useEffect(() => {
    const loadGeofences = async () => {
      try {
        const { createClient } = await import('@/lib/supabase/client')
        const supabase = createClient()
        const { data } = await supabase
          .from('geofences')
          .select('id, name, color, coordinates, is_active')
          .eq('is_active', true)
        if (data) setGeofences(data)
      } catch (e) {
        // Silently fail — map still works without geofences
      }
    }
    loadGeofences()
  }, [])

  return (
    <div className="w-full h-full rounded-xl overflow-hidden border border-slate-200 shadow-sm relative z-0">
      <MapContainer
        center={defaultCenter}
        zoom={12}
        style={{ height: '100%', width: '100%' }}
        zoomControl={false}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <ZoomControl position="bottomright" />
        <FlyToVehicle vehicles={vehicles} selectedVehicleId={selectedVehicleId} />

        {/* Geocercas operativas (desde la BD) */}
        {showGeofences && geofences.filter(g => g.coordinates.length >= 3).map(geo => (
          <Polygon
            key={geo.id}
            positions={geo.coordinates.map(c => [c[0], c[1]] as [number, number])}
            pathOptions={{
              color: geo.color,
              fillColor: geo.color,
              fillOpacity: 0.12,
              weight: 2,
              dashArray: '6 4',
            }}
          >
            <Popup>
              <div className="p-1">
                <p className="font-bold text-slate-800 text-sm">{geo.name}</p>
                <p className="text-xs text-slate-500 mt-1">Zona operativa activa</p>
              </div>
            </Popup>
          </Polygon>
        ))}

        {/* Marcadores de vehículos */}
        {vehicles.map((vehicle) => (
          <Marker
            key={vehicle.id}
            position={[vehicle.lat, vehicle.lng]}
            icon={createTruckIcon(vehicle.status, vehicle.speed)}
            eventHandlers={{ click: () => onVehicleSelect(vehicle.id) }}
          >
            <Popup className="rounded-xl vehicle-popup" minWidth={220}>
              <div className="p-2">
                {/* Header */}
                <div className="flex items-center justify-between mb-3 pb-2 border-b border-slate-100">
                  <div className="flex items-center gap-2">
                    <div className={`w-2.5 h-2.5 rounded-full ${
                      vehicle.status === 'en_ruta' && vehicle.speed > 5 ? 'bg-green-500 animate-pulse' :
                      vehicle.status === 'en_ruta' ? 'bg-yellow-500' :
                      vehicle.status === 'incidencia' ? 'bg-red-500 animate-pulse' : 'bg-orange-500'
                    }`} />
                    <span className="font-black text-slate-800 text-base">{vehicle.plate}</span>
                  </div>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                    vehicle.status === 'en_ruta' && vehicle.speed > 5 ? 'bg-green-100 text-green-700' :
                    vehicle.status === 'en_ruta' ? 'bg-yellow-100 text-yellow-700' :
                    vehicle.status === 'incidencia' ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'
                  }`}>
                    {vehicle.status === 'en_ruta' && vehicle.speed > 5 ? 'EN MOVIMIENTO' :
                     vehicle.status === 'en_ruta' ? 'RALENTÍ' :
                     vehicle.status === 'incidencia' ? 'INCIDENCIA' : 'DETENIDO'}
                  </span>
                </div>

                {/* Driver */}
                <div className="flex items-center gap-2 mb-2">
                  <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  <span className="text-xs text-slate-700 font-medium">{vehicle.driver}</span>
                </div>

                {/* Telemetry grid */}
                <div className="grid grid-cols-2 gap-2 mt-3">
                  <div className="bg-slate-50 rounded-lg p-2 text-center">
                    <p className="text-[10px] text-slate-400 font-medium mb-0.5">VELOCIDAD</p>
                    <p className="text-lg font-black text-slate-800">{vehicle.speed}</p>
                    <p className="text-[9px] text-slate-400">km/h</p>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-2 text-center">
                    <p className="text-[10px] text-slate-400 font-medium mb-0.5">ACTUALIZACIÓN</p>
                    <p className="text-xs font-bold text-green-600 mt-1">{vehicle.lastUpdate}</p>
                  </div>
                </div>

                <div className="mt-2 text-[10px] text-slate-400 text-center">
                  📍 {vehicle.lat.toFixed(5)}, {vehicle.lng.toFixed(5)}
                </div>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>

      <style dangerouslySetInnerHTML={{__html: `
        .leaflet-popup-content-wrapper {
          border-radius: 0.75rem !important;
          box-shadow: 0 20px 25px -5px rgba(0,0,0,0.15), 0 8px 10px -6px rgba(0,0,0,0.1) !important;
          border: 1px solid #e2e8f0 !important;
          padding: 0 !important;
        }
        .leaflet-popup-content { margin: 0 !important; }
        .leaflet-popup-tip-container { display: none; }
        .custom-truck-icon { background: transparent !important; border: none !important; }
        @keyframes pulse-red {
          0%, 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.5); }
          50% { box-shadow: 0 0 0 10px rgba(220, 38, 38, 0); }
        }
        @keyframes pulse-green {
          0%, 100% { box-shadow: 0 0 0 0 rgba(22, 163, 74, 0.4); }
          50% { box-shadow: 0 0 0 8px rgba(22, 163, 74, 0); }
        }
      `}} />
    </div>
  )
}
