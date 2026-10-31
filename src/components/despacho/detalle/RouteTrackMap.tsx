'use client'
import { MapContainer, TileLayer, Polyline, CircleMarker, Tooltip } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { detailTime, type TrackPoint } from '@/lib/dispatch-detail'

/** Recorrido real registrado por el app (no hay ruta planificada en el modelo): inicio y última posición. */
export default function RouteTrackMap({ points }: { points: TrackPoint[] }) {
  const line = points.map(p => [p.lat, p.lon] as [number, number]), first = points[0], last = points[points.length - 1]
  return <MapContainer bounds={line.length > 1 ? line : undefined} center={line.length === 1 ? line[0] : undefined} zoom={line.length === 1 ? 15 : undefined}
    scrollWheelZoom={false} className="h-72 w-full rounded-lg border border-slate-200" aria-label="Recorrido GPS registrado">
    <TileLayer attribution='&copy; OpenStreetMap' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
    {line.length > 1 && <Polyline positions={line} pathOptions={{ color: '#1d4ed8', weight: 4 }} />}
    <CircleMarker center={[first.lat, first.lon]} radius={7} pathOptions={{ color: '#047857', fillColor: '#10b981', fillOpacity: 1 }}><Tooltip>Inicio del recorrido · {detailTime(first.at)}</Tooltip></CircleMarker>
    {points.length > 1 && <CircleMarker center={[last.lat, last.lon]} radius={8} pathOptions={{ color: '#1e3a8a', fillColor: '#2563eb', fillOpacity: 1 }}><Tooltip>Última posición · {detailTime(last.at)}</Tooltip></CircleMarker>}
  </MapContainer>
}
