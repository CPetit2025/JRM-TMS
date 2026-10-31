'use client'
import { MapContainer, TileLayer, Polyline, CircleMarker, Tooltip } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { detailTime, type TrackPoint } from '@/lib/dispatch-detail'

type Place = { lat: number; lon: number; label: string }
/** Ruta sugerida (línea discontinua), recorrido real (línea azul), origen/destino y última posición. */
export default function RouteTrackMap({ points, planned, origin, destination }: { points: TrackPoint[]; planned: [number, number][] | null; origin: Place | null; destination: Place | null }) {
  const real = points.map(p => [p.lat, p.lon] as [number, number]), last = points[points.length - 1]
  const all = [...(planned || []), ...real, ...(origin ? [[origin.lat, origin.lon] as [number, number]] : []), ...(destination ? [[destination.lat, destination.lon] as [number, number]] : [])]
  return <MapContainer bounds={all.length > 1 ? all : undefined} center={all.length === 1 ? all[0] : undefined} zoom={all.length === 1 ? 15 : undefined} boundsOptions={{ padding: [24, 24] }}
    scrollWheelZoom={false} className="h-64 w-full rounded-lg border border-slate-200 sm:h-72" aria-label="Mapa de la ruta">
    <TileLayer attribution='&copy; OpenStreetMap' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
    {planned && <Polyline positions={planned} pathOptions={{ color: '#475569', weight: 3, dashArray: '6 8' }} />}
    {real.length > 1 && <Polyline positions={real} pathOptions={{ color: '#1d4ed8', weight: 4 }} />}
    {origin && <CircleMarker center={[origin.lat, origin.lon]} radius={8} pathOptions={{ color: '#047857', fillColor: '#10b981', fillOpacity: 1 }}><Tooltip permanent direction="right">Origen · {origin.label}</Tooltip></CircleMarker>}
    {destination && <CircleMarker center={[destination.lat, destination.lon]} radius={8} pathOptions={{ color: '#1e3a8a', fillColor: '#2563eb', fillOpacity: 1 }}><Tooltip permanent direction="left">Destino · {destination.label}</Tooltip></CircleMarker>}
    {last && <CircleMarker center={[last.lat, last.lon]} radius={6} pathOptions={{ color: '#ffffff', weight: 2, fillColor: '#f97316', fillOpacity: 1 }}><Tooltip>Última posición · {detailTime(last.at)}</Tooltip></CircleMarker>}
  </MapContainer>
}
