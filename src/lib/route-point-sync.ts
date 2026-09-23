import { createClient } from '@/lib/supabase/client'
import { nativeRouteTracker } from '@/lib/native-route-tracker'

export type RoutePoint = {
  id: string; dispatch_id: string; driver_id: string; recorded_at: string
  latitude: number; longitude: number; accuracy_m: number; speed_mps?: number | null
}

export const routeQueueKey = 'jrm_route_gps_queue_v1'
export const activeRouteKey = 'jrm_active_gps_dispatch_v1'
export const actionQueueKey = 'jrm_offline_actions_v1'

export type OfflineAction = {
  id: string
  type: string
  payload: Record<string, unknown>
  created_at: string
  retry_count: number
  status: 'pending' | 'error'
  last_error?: string
}

export function readRouteQueue(): RoutePoint[] {
  try {
    const points = JSON.parse(localStorage.getItem(routeQueueKey) || '[]')
    return Array.isArray(points) ? points : []
  } catch { return [] }
}

export function readActionQueue(): OfflineAction[] {
  try {
    const actions = JSON.parse(localStorage.getItem(actionQueueKey) || '[]')
    return Array.isArray(actions) ? actions : []
  } catch { return [] }
}

export function saveOfflineAction(type: string, payload: Record<string, unknown>): void {
  const actions = readActionQueue()
  actions.push({
    id: crypto.randomUUID(),
    type,
    payload,
    created_at: new Date().toISOString(),
    retry_count: 0,
    status: 'pending',
  })
  localStorage.setItem(actionQueueKey, JSON.stringify(actions))
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

let runningActions: Promise<number> | null = null

export function syncOfflineActions(): Promise<number> {
  if (runningActions) return runningActions
  runningActions = (async () => {
    if (!navigator.onLine) throw new Error('Sin conexión para sincronizar acciones')
    const supabase = createClient()
    const actions = readActionQueue()
    if (actions.length === 0) return 0

    for (const action of actions) {
      try {
        if (action.type === 'complete_dispatch_stop') {
          // If the payload contains a base64 photo, we must upload it first.
          const dispatchId = String(action.payload.p_dispatch_id || '')
          const requestId = String(action.payload.p_request_id || '')
          const userId = String(action.payload.user_id || '')
          const photoBase64 = typeof action.payload.photo_base64 === 'string' ? action.payload.photo_base64 : null
          let finalPhotoUrl = typeof action.payload.p_photo_url === 'string' ? action.payload.p_photo_url : null

          if (photoBase64) {
            const res = await fetch(photoBase64)
            const blob = await res.blob()
            const filePath = `${userId}/${dispatchId}/${requestId}/${action.id}.jpg`

            const { error: uploadError } = await supabase.storage.from('driver_evidence')
              .upload(filePath, blob, { upsert: true, contentType: 'image/jpeg' })

            if (uploadError) throw uploadError
            finalPhotoUrl = filePath
          }

          const { error } = await supabase.rpc('execute_driver_offline_action', {
            p_operation_id: action.id,
            p_action_type: action.type,
            p_payload: { dispatch_id: dispatchId, request_id: requestId, photo_url: finalPhotoUrl },
          })
          if (error) throw error
        } else if (action.type === 'request_dispatch_return') {
          const { error } = await supabase.rpc('execute_driver_offline_action', {
            p_operation_id: action.id, p_action_type: action.type,
            p_payload: { dispatch_id: String(action.payload.p_dispatch_id || '') },
          })
          if (error) throw error
        } else if (action.type === 'complete_dispatch_return') {
          const { error } = await supabase.rpc('execute_driver_offline_action', {
            p_operation_id: action.id, p_action_type: action.type,
            p_payload: { dispatch_id: String(action.payload.p_dispatch_id || '') },
          })
          if (error) throw error
        } else {
          throw new Error(`Acción offline no soportada: ${action.type}`)
        }

        // Remove processed action
        const currentQueue = readActionQueue()
        localStorage.setItem(actionQueueKey, JSON.stringify(currentQueue.filter(a => a.id !== action.id)))
      } catch (err) {
        console.error(`Error sincronizando acción ${action.type}:`, err)
        const currentQueue = readActionQueue()
        const target = currentQueue.find(a => a.id === action.id)
        if (target) {
          target.retry_count++
          target.status = 'error'
          target.last_error = err instanceof Error ? err.message.slice(0, 300) : 'Error de sincronización'
          localStorage.setItem(actionQueueKey, JSON.stringify(currentQueue))
        }
      }
    }
    return readActionQueue().length
  })().finally(() => { runningActions = null })
  return runningActions
}
