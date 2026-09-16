"use client"

import { useState, useEffect } from 'react'
import { MapContainer, TileLayer, Polygon, Marker, useMapEvents, Polyline } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Reusing icon fixing
delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
})

interface PolygonDrawerMapProps {
  coordinates: [number, number][]
  onChange: (coords: [number, number][]) => void
  color: string
}

function ClickHandler({ onClick }: { onClick: (latlng: L.LatLng) => void }) {
  useMapEvents({
    click(e) {
      onClick(e.latlng)
    },
  })
  return null
}

export default function PolygonDrawerMap({ coordinates, onChange, color }: PolygonDrawerMapProps) {
  // Center roughly on Lima if no coordinates exist
  const defaultCenter: [number, number] = [-12.0464, -77.0428]
  const center = coordinates.length > 0 ? coordinates[0] : defaultCenter

  const handleMapClick = (latlng: L.LatLng) => {
    // Round to 5 decimal places for cleaner text output
    const lat = Number(latlng.lat.toFixed(5))
    const lng = Number(latlng.lng.toFixed(5))
    onChange([...coordinates, [lat, lng]])
  }

  const undoLast = () => {
    if (coordinates.length > 0) {
      onChange(coordinates.slice(0, -1))
    }
  }

  const clearAll = () => {
    onChange([])
  }

  return (
    <div className="relative w-full h-[300px] rounded-lg overflow-hidden border border-slate-300">
      <MapContainer
        center={center}
        zoom={12}
        style={{ height: '100%', width: '100%', cursor: 'crosshair' }}
      >
        <TileLayer
          attribution='&copy; OpenStreetMap'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        
        <ClickHandler onClick={handleMapClick} />

        {/* Draw lines between points as they click */}
        {coordinates.length > 0 && (
          <Polyline 
            positions={coordinates.map(c => [c[0], c[1]])} 
            color={color}
            weight={2}
            dashArray="5, 5"
          />
        )}

        {/* Draw completed polygon if 3 or more points */}
        {coordinates.length >= 3 && (
          <Polygon 
            positions={coordinates.map(c => [c[0], c[1]])} 
            pathOptions={{ color, fillColor: color, fillOpacity: 0.3, weight: 2 }} 
          />
        )}

        {/* Draw markers for each point */}
        {coordinates.map((coord, idx) => (
          <Marker 
            key={`${idx}-${coord[0]}-${coord[1]}`} 
            position={[coord[0], coord[1]]}
            opacity={0.8}
          />
        ))}
      </MapContainer>

      {/* Floating Controls */}
      <div className="absolute top-2 right-2 z-[400] flex flex-col gap-2">
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); undoLast(); }}
          disabled={coordinates.length === 0}
          className="bg-white text-slate-700 px-3 py-1.5 rounded-lg shadow-md text-xs font-bold hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed border border-slate-200"
        >
          ↩️ Deshacer
        </button>
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); clearAll(); }}
          disabled={coordinates.length === 0}
          className="bg-white text-red-600 px-3 py-1.5 rounded-lg shadow-md text-xs font-bold hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed border border-slate-200"
        >
          🗑️ Limpiar
        </button>
      </div>

      {coordinates.length < 3 && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-[400] pointer-events-none">
          <div className="bg-slate-800/80 text-white text-[10px] font-medium px-3 py-1.5 rounded-full backdrop-blur-sm">
            Haz clic en el mapa para añadir puntos ({coordinates.length}/3 mín)
          </div>
        </div>
      )}
    </div>
  )
}
