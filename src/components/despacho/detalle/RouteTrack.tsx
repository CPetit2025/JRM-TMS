'use client'
import { useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import { createClient } from '@/lib/supabase/client'
import { thinTrack, type TrackPoint } from '@/lib/dispatch-detail'

const RouteTrackMap = dynamic(() => import('./RouteTrackMap'), { ssr: false, loading: () => <p role="status" className="py-8 text-center text-sm text-slate-500">Cargando mapa…</p> })

/** Recorrido GPS de la ruta con los puntos que envió el app; sin puntos (o sin permiso) no se dibuja nada. */
export function RouteTrack({ dispatchId }: { dispatchId: string }) {
  const db = useMemo(() => createClient(), [])
  const [state, setState] = useState<{ id: string; points: TrackPoint[]; error: string }>({ id: '', points: [], error: '' })
  useEffect(() => {
    let alive = true
    void Promise.resolve(db.from('route_track_points').select('recorded_at,latitude,longitude').eq('dispatch_id', dispatchId).order('recorded_at').limit(5000))
      .then(({ data, error }) => {
        if (!alive) return
        const points = ((data || []) as { recorded_at: string; latitude: number | string; longitude: number | string }[])
          .map(p => ({ at: p.recorded_at, lat: Number(p.latitude), lon: Number(p.longitude) })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon))
        setState({ id: dispatchId, points: thinTrack(points), error: error ? 'Sin acceso al recorrido GPS de la ruta.' : '' })
      }).catch(() => { if (alive) setState({ id: dispatchId, points: [], error: 'No se pudo cargar el recorrido GPS.' }) })
    return () => { alive = false }
  }, [db, dispatchId])
  if (state.id !== dispatchId) return <p role="status" className="text-sm text-slate-500">Cargando recorrido…</p>
  if (state.error) return <p className="text-sm text-slate-500">{state.error}</p>
  if (!state.points.length) return <p className="text-sm text-slate-500">Sin puntos GPS registrados para esta ruta.</p>
  return <div className="space-y-1"><RouteTrackMap points={state.points} /><p className="text-xs text-slate-500">Recorrido real registrado por el app del conductor. No incluye una ruta planificada.</p></div>
}
