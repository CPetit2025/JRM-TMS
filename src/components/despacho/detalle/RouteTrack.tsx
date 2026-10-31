'use client'
import { useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { districtOf } from '@/lib/address'
import { thinTrack, type RouteEstimateData, type TrackPoint } from '@/lib/dispatch-detail'

const RouteTrackMap = dynamic(() => import('./RouteTrackMap'), { ssr: false, loading: () => <p role="status" className="grid h-64 place-items-center rounded-lg bg-slate-100 text-sm text-slate-500">Cargando mapa…</p> })

/**
 * Mapa de la parada: ruta sugerida por OSRM al programar (si se guardó) y recorrido real que envió el app del conductor.
 * Sin estimado ni puntos no se dibuja nada; nunca se inventa un trazo.
 */
export function RouteTrack({ dispatchId, gps, estimate, origin, destination }: { dispatchId: string; gps: boolean; estimate: RouteEstimateData | null; origin: string; destination: string }) {
  const db = useMemo(() => createClient(), [])
  const [state, setState] = useState<{ id: string; points: TrackPoint[]; error: string }>({ id: '', points: [], error: '' })
  useEffect(() => {
    if (!gps) return
    let alive = true
    void Promise.resolve(db.from('route_track_points').select('recorded_at,latitude,longitude').eq('dispatch_id', dispatchId).order('recorded_at').limit(5000))
      .then(({ data, error }) => {
        if (!alive) return
        const points = ((data || []) as { recorded_at: string; latitude: number | string; longitude: number | string }[])
          .map(p => ({ at: p.recorded_at, lat: Number(p.latitude), lon: Number(p.longitude) })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon))
        setState({ id: dispatchId, points: thinTrack(points), error: error ? 'Sin acceso al recorrido GPS de la ruta.' : '' })
      }).catch(() => { if (alive) setState({ id: dispatchId, points: [], error: 'No se pudo cargar el recorrido GPS.' }) })
    return () => { alive = false }
  }, [db, dispatchId, gps])
  const loading = gps && state.id !== dispatchId, points = gps && state.id === dispatchId ? state.points : []
  const planned = estimate?.geometry?.length ? estimate.geometry : null
  if (loading && !planned) return <p role="status" className="text-sm text-slate-500">Cargando recorrido…</p>
  if (!planned && !points.length) return <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">{gps ? state.error || 'Sin puntos GPS registrados para esta ruta.' : 'Unidad sin GPS del app.'} Sin ruta sugerida guardada al programar.</p>
  return <div className="space-y-1">
    <RouteTrackMap points={points} planned={planned} origin={estimate?.origin ? { ...estimate.origin, label: districtOf(origin) || 'Origen' } : null}
      destination={estimate?.destination ? { ...estimate.destination, label: districtOf(destination) || 'Destino' } : null} />
    <p className="flex flex-wrap gap-x-4 text-xs text-slate-500">
      {planned && <span className="flex items-center gap-1.5"><span aria-hidden className="h-0.5 w-5 border-t-2 border-dashed border-slate-500" />Ruta sugerida (OSRM)</span>}
      {points.length > 0 && <span className="flex items-center gap-1.5"><span aria-hidden className="h-1 w-5 rounded bg-blue-700" />Recorrido real del app</span>}
      {gps && !loading && !points.length && <span>{state.error || 'Sin puntos GPS registrados.'}</span>}
    </p>
  </div>
}
