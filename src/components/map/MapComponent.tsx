"use client"

import { useEffect, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup, ZoomControl } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Arreglo para el ícono por defecto de Leaflet en Next.js
delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
})

// Ícono personalizado para los camiones
const truckIcon = new L.Icon({
  iconUrl: 'https://cdn-icons-png.flaticon.com/512/3204/3204092.png',
  iconSize: [32, 32],
  iconAnchor: [16, 32],
  popupAnchor: [0, -32],
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

interface MapComponentProps {
  vehicles: VehicleLocation[]
  selectedVehicleId: string | null
  onVehicleSelect: (id: string) => void
}

export default function MapComponent({ vehicles, selectedVehicleId, onVehicleSelect }: MapComponentProps) {
  const [map, setMap] = useState<L.Map | null>(null)

  // Centro de Lima por defecto
  const defaultCenter: [number, number] = [-12.0464, -77.0428]

  useEffect(() => {
    if (map && selectedVehicleId) {
      const vehicle = vehicles.find(v => v.id === selectedVehicleId)
      if (vehicle) {
        map.flyTo([vehicle.lat, vehicle.lng], 15, {
          animate: true,
          duration: 1.5
        })
      }
    }
  }, [map, selectedVehicleId, vehicles])

  return (
    <div className="w-full h-full rounded-xl overflow-hidden border border-slate-200 shadow-sm relative z-0">
      <MapContainer 
        center={defaultCenter} 
        zoom={12} 
        style={{ height: '100%', width: '100%' }}
        zoomControl={false}
        ref={setMap}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          className="map-tiles"
        />
        <ZoomControl position="bottomright" />

        {vehicles.map((vehicle) => (
          <Marker 
            key={vehicle.id} 
            position={[vehicle.lat, vehicle.lng]}
            icon={truckIcon}
            eventHandlers={{
              click: () => onVehicleSelect(vehicle.id),
            }}
          >
            <Popup className="rounded-xl">
              <div className="p-1">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-bold text-[#002855] text-base">{vehicle.plate}</h3>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                    vehicle.status === 'en_ruta' ? 'bg-green-100 text-green-700' :
                    vehicle.status === 'detenido' ? 'bg-orange-100 text-orange-700' :
                    'bg-red-100 text-red-700'
                  }`}>
                    {vehicle.status === 'en_ruta' ? 'En Ruta' : vehicle.status === 'detenido' ? 'Detenido' : 'Incidencia'}
                  </span>
                </div>
                <div className="space-y-1 text-sm text-slate-600">
                  <p><span className="font-medium text-slate-700">Conductor:</span> {vehicle.driver}</p>
                  <p><span className="font-medium text-slate-700">Velocidad:</span> {vehicle.speed} km/h</p>
                  <p><span className="font-medium text-slate-700">Última act.:</span> {vehicle.lastUpdate}</p>
                </div>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
      <style dangerouslySetInnerHTML={{__html: `
        .leaflet-popup-content-wrapper { border-radius: 0.75rem; box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1); }
        .map-tiles { filter: sepia(0.2) hue-rotate(180deg) saturate(0.8) contrast(1.1); } 
      `}} />
    </div>
  )
}
