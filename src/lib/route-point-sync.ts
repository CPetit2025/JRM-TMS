import { createClient } from '@/lib/supabase/client'
import { nativeRouteTracker } from '@/lib/native-route-tracker'

export type RoutePoint = {
  id: string; dispatch_id: string; driver_id: string; recorded_at: string
  latitude: number; longitude: number; accuracy_m: number; speed_mps?: number | null
}

export const routeQueueKey = 'jrm_route_gps_queue_v1'
export const activeRouteKey = 'jrm_active_gps_dispatch_v1'

export function readRouteQueue(): RoutePoint[] {
  try {
    const points = JSON.parse(localStorage.getItem(routeQueueKey) || '[]')
    return Array.isArray(points) ? points : []
  } catch { return [] }
}

let running: Promise<number> | null = null

export function syncRoutePoints(): Promise<number> {
  if (running) return running
  running = (async () => {
    if (!navigator.onLine) throw new Error('Sin conexión para sincronizar puntos GPS')
    const supabase = createClient()
    for (let batch = 0; batch < 5000; batch++) {
      const browserPoints = readRouteQueue()
      const nativePoints = nativeRouteTracker ? (await nativeRouteTracker.pending()).points : []
      const next = [
        ...browserPoints.map(point => ({ point, source: 'browser' })),
        ...nativePoints.map(point => ({ point, source: 'native' }))
      ].sort((a, b) => Date.parse(a.point.recorded_at) - Date.parse(b.point.recorded_at))[0]
      if (!next) return 0
      const { error } = await supabase.from('route_track_points').insert(next.point)
      if (error) throw new Error(`Punto GPS ${next.point.recorded_at}: ${error.message}`)
      if (next.source === 'browser') {
        localStorage.setItem(routeQueueKey,
          JSON.stringify(readRouteQueue().filter(point => point.id !== next.point.id)))
      } else {
        await nativeRouteTracker!.acknowledge({ ids: [next.point.id] })
      }
    }
    return readRouteQueue().length + (nativeRouteTracker ? (await nativeRouteTracker.pending()).points.length : 0)
  })().finally(() => { running = null })
  return running
}
