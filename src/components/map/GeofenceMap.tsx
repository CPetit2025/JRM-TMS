"use client"

import { useEffect } from 'react'
import { MapContainer, TileLayer, Polygon, Popup, ZoomControl, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
})

interface Geofence {
  id: string
  name: string
  color: string
  type: string
  coordinates: [number, number][]
  is_active: boolean
  description: string | null
}

interface GeofenceMapProps {
  geofences: Geofence[]
  selectedId: string | null
  onSelect: (id: string | null) => void
}

const TYPE_LABELS: Record<string, string> = {
  cedi: 'CEDI / Almacén',
  depot: 'Depósito',
  zona_distribucion: 'Zona de Distribución',
  restringida: 'Zona Restringida',
}

function FlyToSelected({ geofences, selectedId }: { geofences: Geofence[], selectedId: string | null }) {
  const map = useMap()
  useEffect(() => {
    if (!selectedId) return
    const geo = geofences.find(g => g.id === selectedId)
    if (!geo || geo.coordinates.length === 0) return
    const bounds = L.latLngBounds(geo.coordinates.map(c => [c[0], c[1]] as [number, number]))
    map.flyToBounds(bounds, { padding: [60, 60], maxZoom: 15, animate: true, duration: 1.0 })
  }, [map, selectedId, geofences])
  return null
}

export default function GeofenceMap({ geofences, selectedId, onSelect }: GeofenceMapProps) {
  const defaultCenter: [number, number] = [-12.0464, -77.0428]

  return (
    <div className="w-full h-full rounded-xl overflow-hidden border border-slate-200 shadow-sm relative z-0">
      <MapContainer
        center={defaultCenter}
        zoom={11}
        style={{ height: '100%', width: '100%' }}
        zoomControl={false}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <ZoomControl position="bottomright" />
        <FlyToSelected geofences={geofences} selectedId={selectedId} />

        {geofences.filter(g => g.coordinates.length >= 3).map(geo => (
          <Polygon
            key={geo.id}
            positions={geo.coordinates.map(c => [c[0], c[1]] as [number, number])}
            pathOptions={{
              color: geo.color,
              fillColor: geo.color,
              fillOpacity: geo.is_active ? (selectedId === geo.id ? 0.30 : 0.15) : 0.05,
              weight: selectedId === geo.id ? 3 : (geo.is_active ? 2 : 1),
              dashArray: geo.is_active ? undefined : '6 4',
              opacity: geo.is_active ? 1 : 0.4,
            }}
            eventHandlers={{ click: () => onSelect(geo.id === selectedId ? null : geo.id) }}
          >
            <Popup>
              <div className="p-2 min-w-[180px]">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: geo.color }} />
                  <span className="font-black text-slate-800 text-sm">{geo.name}</span>
                </div>
                <p className="text-xs text-slate-500 mb-1">{TYPE_LABELS[geo.type] || geo.type}</p>
                {geo.description && <p className="text-xs text-slate-400 italic">{geo.description}</p>}
                <div className="mt-2 pt-2 border-t border-slate-100 flex items-center gap-1.5">
                  <div className={`w-2 h-2 rounded-full ${geo.is_active ? 'bg-green-500' : 'bg-slate-400'}`} />
                  <span className={`text-[10px] font-bold ${geo.is_active ? 'text-green-600' : 'text-slate-500'}`}>
                    {geo.is_active ? 'ACTIVA' : 'INACTIVA'}
                  </span>
                  <span className="text-[10px] text-slate-400 ml-auto">{geo.coordinates.length} puntos</span>
                </div>
              </div>
            </Popup>
          </Polygon>
        ))}
      </MapContainer>

      {/* Empty state overlay */}
      {geofences.filter(g => g.coordinates.length >= 3).length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-[400]">
          <div className="bg-white/90 backdrop-blur-sm rounded-xl shadow-lg p-6 text-center max-w-xs">
            <p className="text-slate-500 text-sm font-medium">No hay geocercas para mostrar</p>
            <p className="text-slate-400 text-xs mt-1">Crea la primera con el botón "Nueva Geocerca"</p>
          </div>
        </div>
      )}

      <style dangerouslySetInnerHTML={{ __html: `
        .leaflet-popup-content-wrapper { border-radius: 0.75rem !important; box-shadow: 0 10px 30px rgba(0,0,0,0.12) !important; border: 1px solid #e2e8f0 !important; padding: 0 !important; }
        .leaflet-popup-content { margin: 0 !important; }
        .leaflet-popup-tip-container { display: none; }
      `}} />
    </div>
  )
}
