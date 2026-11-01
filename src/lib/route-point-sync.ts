import { createClient } from '@/lib/supabase/client'
import { nativeRouteTracker } from '@/lib/native-route-tracker'

// Fotos guardadas en el dispositivo: normalmente JPG reducido; el original (PNG, WEBP o HEIC) si el teléfono no pudo reducirla.
const PHOTO_KINDS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' }
function photoKind(value: unknown): { type: string; ext: string } | null {
  if (typeof value !== 'string') return null
  const type = /^data:([^;,]+);base64,/.exec(value)?.[1]
  return type && PHOTO_KINDS[type] ? { type, ext: PHOTO_KINDS[type] } : null
}

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

export function saveOfflineAction(type: string, payload: Record<string, unknown>, operationId = crypto.randomUUID()): void {
  const actions = readActionQueue()
  if (actions.some(action => action.id === operationId)) return
  actions.push({
    id: operationId,
    type,
    payload,
    created_at: new Date().toISOString(),
    retry_count: 0,
    status: 'pending',
  })
  localStorage.setItem(actionQueueKey, JSON.stringify(actions))
}

// P0001: regla del servidor (orden, ruta cerrada, plazo); 42501: RLS; 23505/23502/23514/22P02: datos inválidos o repetidos
const PERMANENT_POINT_CODES = new Set(['P0001', '42501', '23505', '23502', '23514', '22P02'])
function permanentPointError(error: { code?: string; message?: string }) {
  return PERMANENT_POINT_CODES.has(error.code || '') || /deben llegar en orden|sin conductor activo|fuera de rango|no autorizado|row-level security/i.test(error.message || '')
}

let running: Promise<number> | null = null
// Puntos por petición: una hora de ruta son ~3.600 puntos; de uno en uno, con datos móviles débiles, la cola no se
// pone al día. El servidor valida cada punto en orden dentro del mismo lote.
const ROUTE_BATCH = 200

export function syncRoutePoints(): Promise<number> {
  if (running) return running
  running = (async () => {
    if (!navigator.onLine) throw new Error('Sin conexión para sincronizar puntos GPS')
    const supabase = createClient()
    type Item = { point: RoutePoint; source: 'browser' | 'native' }
    const done = async (items: Item[]) => {
      const browserIds = new Set(items.filter(item => item.source === 'browser').map(item => item.point.id))
      if (browserIds.size) localStorage.setItem(routeQueueKey, JSON.stringify(readRouteQueue().filter(point => !browserIds.has(point.id))))
      const nativeIds = items.filter(item => item.source === 'native').map(item => item.point.id)
      if (nativeIds.length) await nativeRouteTracker!.acknowledge({ ids: nativeIds })
    }
    for (let batch = 0; batch < 5000; batch++) {
      const browserPoints = readRouteQueue()
      const nativePoints = nativeRouteTracker ? (await nativeRouteTracker.pending()).points : []
      const next: Item[] = [
        ...browserPoints.map(point => ({ point, source: 'browser' as const })),
        ...nativePoints.map(point => ({ point, source: 'native' as const }))
      ].sort((a, b) => Date.parse(a.point.recorded_at) - Date.parse(b.point.recorded_at)).slice(0, ROUTE_BATCH)
      if (!next.length) return 0
      const { error } = await supabase.from('route_track_points').insert(next.map(item => item.point))
      if (!error) { await done(next); continue }
      if (!permanentPointError(error)) throw new Error(`Puntos GPS desde ${next[0].point.recorded_at}: ${error.message}`)
      // Un punto rechazado (fuera de orden, ruta cerrada, plazo, permiso) no debe trabar el lote: se reintenta de
      // uno en uno, se descartan solo los rechazados y los errores de red detienen la sincronización.
      for (let index = 0; index < next.length; index++) {
        const item = next[index]
        const single = await supabase.from('route_track_points').insert(item.point)
        if (single.error && !permanentPointError(single.error)) {
          await done(next.slice(0, index))
          throw new Error(`Punto GPS ${item.point.recorded_at}: ${single.error.message}`)
        }
        if (single.error) console.warn('Punto GPS descartado', item.point.recorded_at, single.error.message)
      }
      await done(next)
    }
    return readRouteQueue().length + (nativeRouteTracker ? (await nativeRouteTracker.pending()).points.length : 0)
  })().finally(() => { running = null })
  return running
}

// Puntos que esperan subir (navegador + servicio nativo) y el más antiguo: los reporta el aviso de conexión
export async function pendingRouteSummary(): Promise<{ count: number; oldest: string | null }> {
  const points = [...readRouteQueue(), ...(nativeRouteTracker ? (await nativeRouteTracker.pending().catch(() => ({ points: [] as RoutePoint[] }))).points : [])]
  const oldest = points.reduce<string | null>((min, point) => !min || point.recorded_at < min ? point.recorded_at : min, null)
  return { count: points.length, oldest }
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
        if (action.type === 'delivery_submit_driver') {
          const { data: auth } = await supabase.auth.getUser()
          if (!auth.user || auth.user.id !== action.payload.user_id) throw new Error('La sesión no corresponde a esta evidencia')
          const photos = action.payload.photos_base64
          if (!Array.isArray(photos) || photos.length < 1 || photos.length > 5) throw new Error('Fotos pendientes no válidas')
          const paths: string[] = []
          for (let index = 0; index < photos.length; index++) {
            const kind = photoKind(photos[index])
            if (!kind) throw new Error('Fotografía no válida: use JPG, PNG, WEBP o HEIC')
            const blob = await (await fetch(photos[index])).blob()
            const path = `${auth.user.id}/${action.payload.dispatch_id}/${action.payload.request_id}/${action.id}-${index}.${kind.ext}`
            const { error } = await supabase.storage.from('driver_evidence').upload(path, blob, { upsert: false, contentType: kind.type })
            if (error && String(error.statusCode) !== '409') throw error
            paths.push(path)
          }
          // Packing List del servicio (opcional): mismas reglas de formato y carpeta que la guía.
          const packing = Array.isArray(action.payload.packing_base64) ? action.payload.packing_base64 : []
          if (packing.length > 5) throw new Error('Fotos del Packing List no válidas')
          const packingPaths: string[] = []
          for (let index = 0; index < packing.length; index++) {
            const kind = photoKind(packing[index])
            if (!kind) throw new Error('Fotografía del Packing List no válida: use JPG, PNG, WEBP o HEIC')
            const blob = await (await fetch(packing[index])).blob()
            const path = `${auth.user.id}/${action.payload.dispatch_id}/${action.payload.request_id}/${action.id}-p${index}.${kind.ext}`
            const { error } = await supabase.storage.from('driver_evidence').upload(path, blob, { upsert: false, contentType: kind.type })
            if (error && String(error.statusCode) !== '409') throw error
            packingPaths.push(path)
          }
          let odometerPhotoPath: string | null = null
          const odometerPhoto = action.payload.odometer_photo_base64
          if (odometerPhoto != null) {
            const kind = photoKind(odometerPhoto)
            if (!kind) throw new Error('Foto del odómetro no válida: use JPG, PNG o WEBP')
            const blob = await (await fetch(odometerPhoto as string)).blob()
            odometerPhotoPath = `${auth.user.id}/${action.payload.dispatch_id}/${action.payload.request_id}/${action.id}-odometer.${kind.ext}`
            const { error } = await supabase.storage.from('driver_evidence').upload(odometerPhotoPath, blob, { upsert: false, contentType: kind.type })
            if (error && String(error.statusCode) !== '409') throw error
          }
          const { data, error } = await supabase.rpc('execute_driver_offline_action', {
            p_operation_id: action.id, p_action_type: action.type,
            p_payload: { dispatch_id: action.payload.dispatch_id, request_id: action.payload.request_id, photos: paths, packing_photos: packingPaths,
              received_by: action.payload.received_by, guide: action.payload.guide, note: action.payload.note, captured_at: action.payload.captured_at,
              odometer: action.payload.odometer, odometer_photo: odometerPhotoPath },
          })
          if (error) throw error
          if (!data?.success) throw new Error(data?.error || 'El servidor no confirmó la guía')
        } else if (action.type === 'delivery_reject_driver') {
          // Rechazo en destino guardado en el teléfono: sube las fotos a la carpeta de la entrega y lo registra
          const { data: auth } = await supabase.auth.getUser()
          if (!auth.user || auth.user.id !== action.payload.user_id) throw new Error('La sesión no corresponde a este rechazo')
          const photos = action.payload.photos_base64
          if (!Array.isArray(photos) || photos.length < 1 || photos.length > 5) throw new Error('Fotos del rechazo no válidas')
          const paths: string[] = []
          for (let index = 0; index < photos.length; index++) {
            const kind = photoKind(photos[index])
            if (!kind) throw new Error('Fotografía no válida: use JPG, PNG, WEBP o HEIC')
            const blob = await (await fetch(photos[index])).blob()
            const path = `${auth.user.id}/${action.payload.dispatch_id}/${action.payload.request_id}/${action.id}-r${index}.${kind.ext}`
            const { error } = await supabase.storage.from('driver_evidence').upload(path, blob, { upsert: false, contentType: kind.type })
            if (error && String(error.statusCode) !== '409') throw error
            paths.push(path)
          }
          const { data, error } = await supabase.rpc('execute_driver_offline_action', {
            p_operation_id: action.id, p_action_type: action.type,
            p_payload: { dispatch_id: action.payload.dispatch_id, request_id: action.payload.request_id, kind: action.payload.kind,
              reason: action.payload.reason, note: action.payload.note, photos: paths, latitude: action.payload.latitude,
              longitude: action.payload.longitude, accuracy_m: action.payload.accuracy_m, captured_at: action.payload.captured_at },
          })
          if (error) throw error
          if (!data?.success) throw new Error(data?.error || 'El servidor no confirmó el rechazo')
        } else if (action.type === 'complete_dispatch_stop') {
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
              .upload(filePath, blob, { upsert: false, contentType: 'image/jpeg' })

            if (uploadError && String(uploadError.statusCode) !== '409') throw uploadError
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
          target.last_error = err && typeof err === 'object' && 'message' in err ? String(err.message).slice(0, 300) : 'Error de sincronización'
          localStorage.setItem(actionQueueKey, JSON.stringify(currentQueue))
        }
      }
    }
    return readActionQueue().length
  })().finally(() => { runningActions = null })
  return runningActions
}
