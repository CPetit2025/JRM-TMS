'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

// Avisos proactivos del copiloto para el conductor. Se evalúan con su viaje activo (get_active_trip_context), el GPS del
// teléfono y la geocerca de planta (authorized_locations). Llegada al destino:
// · Si el destino tiene un punto aprendido de entregas anteriores (geocerca ~150 m), el copiloto registra la llegada
//   solo cuando la unidad entra con GPS preciso y se detiene ~2 min, y avisa «Registré tu llegada · Deshacer».
// · Sin punto aprendido, al detenerse varios minutos ofrece «Confirmar llegada» en un toque.
// El copiloto nunca entrega ni rechaza: la guía o el rechazo los registra siempre el conductor.

export type NudgeAction = { label: string; href?: string; ask?: string; run?: () => Promise<string | void> | void }  // run: acción directa; si devuelve una ruta, se abre
export type Nudge = { key: string; text: string; actions: NudgeAction[] }

type Stop = { transport_request_id?: string; status?: string; conformity?: string; delivery_address?: string | null; request_number?: string | null
  arrived_at?: string | null; arrival_source?: string | null; destination?: { lat: number; lon: number; radius_m?: number } | null }
type Trip = { id: string; status: string; vehicle_plate?: string | null; scheduled_departure?: string | null; stops?: Stop[] }
type TripContext = { trip: Trip | null; pending?: { checklist?: boolean; stops?: number } }
type Place = { name: string; latitude: number; longitude: number; radius_km: number }

const STOP_MINUTES = 4            // detenido este tiempo durante la ruta → probable llegada
const STOP_RADIUS_M = 120         // movimiento máximo para considerar la unidad detenida
const AUTO_STOP_MINUTES = 2       // detenido dentro de la geocerca del destino → llegada automática
const AUTO_ACCURACY_M = 50        // GPS mínimo para registrar la llegada sin el conductor
const NEAR_DESTINATION_M = 500    // con punto aprendido, el aviso manual solo se ofrece cerca del destino
const UNDO_MS = 30 * 60_000       // la llegada automática se puede deshacer durante este tiempo
const COOLDOWN_MS = 15 * 60_000   // un aviso descartado vuelve a mostrarse pasado este tiempo
const STORE = 'jrm-ai-nudges'

const meters = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const r = 6_371_000, rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * r * Math.asin(Math.sqrt(h))
}
const DONE = ['VALIDADA', 'NO_APLICA', 'RECHAZO_DESTINO']
const stopDone = (stop: Stop) => stop.status === 'ENTREGADO' || DONE.includes(stop.conformity || '')
const readSeen = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(STORE) || '{}') } catch { return {} } }
const writeSeen = (seen: Record<string, number>) => { try { localStorage.setItem(STORE, JSON.stringify(seen)) } catch { /* sin almacenamiento */ } }

export function useDriverNudges(enabled: boolean) {
  const supabase = useMemo(() => createClient(), [])
  const [context, setContext] = useState<TripContext | null>(null)
  const [places, setPlaces] = useState<Place[]>([])
  const [position, setPosition] = useState<{ lat: number; lon: number; accuracy: number } | null>(null)
  const autoTried = useRef<Set<string>>(new Set())
  const [stoppedSince, setStoppedSince] = useState<number | null>(null)
  const anchor = useRef<{ lat: number; lon: number } | null>(null)
  const [seenTick, setSeenTick] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  // Viaje activo: al abrir, cada minuto y cuando el app avisa un cambio
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const load = async () => {
      const { data } = await supabase.rpc('get_active_trip_context')
      if (!cancelled) setContext((data as TripContext) || null)
    }
    const first = window.setTimeout(() => void load(), 0)
    supabase.from('authorized_locations').select('name, latitude, longitude, radius_km').eq('is_active', true)
      .then(({ data }) => { if (!cancelled) setPlaces((data as Place[]) || []) })
    const timer = window.setInterval(() => { void load(); setNow(Date.now()) }, 60_000)
    const onChange = () => void load()
    window.addEventListener('jrm:trip-changed', onChange)
    return () => { cancelled = true; window.clearTimeout(first); window.clearInterval(timer); window.removeEventListener('jrm:trip-changed', onChange) }
  }, [enabled, supabase])
  const changed = useCallback(() => window.dispatchEvent(new Event('jrm:trip-changed')), [])

  const trip = context?.trip || null
  const moving = !!trip && ['EN RUTA', 'EN_CURSO', 'RETORNO'].includes(trip.status)

  // GPS solo mientras la unidad está en ruta
  useEffect(() => {
    if (!enabled || !moving || typeof navigator === 'undefined' || !navigator.geolocation) return
    const id = navigator.geolocation.watchPosition(pos => {
      const here = { lat: pos.coords.latitude, lon: pos.coords.longitude }
      setPosition({ ...here, accuracy: pos.coords.accuracy })
      setNow(Date.now())
      if (!anchor.current || meters(anchor.current, here) > STOP_RADIUS_M) {
        anchor.current = here
        setStoppedSince(Date.now())
      }
    }, () => undefined, { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 })
    return () => navigator.geolocation.clearWatch(id)
  }, [enabled, moving])

  // Parada en curso: la primera sin cerrar (entregada y aprobada, recojo del cliente o rechazada en destino)
  const stops = useMemo(() => trip?.stops || [], [trip])
  const current = stops.find(stop => !stopDone(stop))
  const destinationMeters = position && current?.destination ? meters(position, current.destination) : null
  const insideGeofence = destinationMeters != null && destinationMeters <= (current?.destination?.radius_m || 150)

  const arrive = useCallback(async (stop: Stop, source: 'COPILOTO' | 'AUTO_GEOCERCA') => {
    if (!trip || !stop.transport_request_id) return false
    const { error } = await supabase.rpc('delivery_arrive_at', { p_dispatch: trip.id, p_request: stop.transport_request_id,
      p_lat: position?.lat ?? null, p_lon: position?.lon ?? null, p_accuracy: position ? Math.round(position.accuracy) : null, p_source: source })
    if (!error) changed()
    return !error
  }, [supabase, trip, position, changed])
  const undo = useCallback(async (stop: Stop) => {
    if (!trip || !stop.transport_request_id) return
    const { error } = await supabase.rpc('delivery_arrive_undo', { p_dispatch: trip.id, p_request: stop.transport_request_id })
    if (!error) changed()
  }, [supabase, trip, changed])

  // Llegada automática: dentro de la geocerca del destino aprendido, GPS preciso y unidad detenida ~2 min
  const stoppedMin = stoppedSince ? (now - stoppedSince) / 60_000 : 0
  useEffect(() => {
    if (!enabled || !trip || !['EN RUTA', 'EN_CURSO'].includes(trip.status) || !current?.transport_request_id || current.arrived_at) return
    if (!insideGeofence || !position || position.accuracy > AUTO_ACCURACY_M || stoppedMin < AUTO_STOP_MINUTES) return
    if (typeof navigator !== 'undefined' && !navigator.onLine) return
    const key = `${trip.id}:${current.transport_request_id}`
    if (autoTried.current.has(key)) return
    autoTried.current.add(key)
    void arrive(current, 'AUTO_GEOCERCA')
  }, [enabled, trip, current, insideGeofence, position, stoppedMin, arrive])

  const nudge = useMemo<Nudge | null>(() => {
    void seenTick
    if (!enabled || !trip) return null
    const seen = readSeen()
    const fresh = (key: string) => !seen[key] || now - seen[key] > COOLDOWN_MS
    const plate = trip.vehicle_plate ? ` ${trip.vehicle_plate}` : ''
    const nextName = current?.delivery_address || current?.request_number || 'tu próxima parada'
    const pendingStops = context?.pending?.stops ?? stops.filter(stop => !stopDone(stop)).length

    if (trip.status === 'PROGRAMADO') {
      if (context?.pending?.checklist && fresh(`checklist:${trip.id}`)) {
        return { key: `checklist:${trip.id}`, text: `Antes de salir, completa el checklist de la unidad${plate}.`,
          actions: [{ label: 'Abrir checklist', href: '/app/checklist' }] }
      }
      const departure = trip.scheduled_departure ? new Date(trip.scheduled_departure).getTime() : null
      if (!context?.pending?.checklist && departure && departure - now <= 30 * 60_000 && fresh(`start:${trip.id}`)) {
        return { key: `start:${trip.id}`, text: `Ya es hora de salir hacia ${nextName}. Inicia la ruta para registrar tu recorrido.`,
          actions: [{ label: 'Ir a mi ruta', href: '/app/ruta' }] }
      }
      return null
    }
    if (!moving) return null
    const plant = position ? places.find(place => meters(position, { lat: place.latitude, lon: place.longitude }) <= Math.max(place.radius_km, 0.2) * 1000) : undefined
    if (pendingStops === 0 || !current) {
      if (plant && fresh(`return:${trip.id}`)) {
        return { key: `return:${trip.id}`, text: `Llegaste a ${plant.name}. Confirma tu retorno para cerrar el viaje.`,
          actions: [{ label: 'Confirmar retorno', href: '/app/ruta' }] }
      }
      if (!plant && fresh(`back:${trip.id}`)) {
        return { key: `back:${trip.id}`, text: 'Completaste todas las entregas. Registra tu retorno a planta desde tu ruta.',
          actions: [{ label: 'Ir a mi ruta', href: '/app/ruta' }] }
      }
      return null
    }
    const stopKey = `${trip.id}:${current.transport_request_id || stops.indexOf(current)}`
    // Llegada registrada por el copiloto: aviso con la opción de deshacerla
    if (current.arrived_at && current.arrival_source === 'AUTO_GEOCERCA' && now - new Date(current.arrived_at).getTime() < UNDO_MS && fresh(`auto:${stopKey}`)) {
      const time = new Date(current.arrived_at).toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit' })
      return { key: `auto:${stopKey}`, text: `Registré tu llegada a ${nextName} (${time}). Ahora registra la entrega con la guía firmada.`,
        actions: [{ label: 'Ir a la entrega', href: '/app/ruta' }, { label: 'Deshacer', run: () => undo(current) }] }
    }
    if (current.arrived_at) return null
    // Sin llegada automática: al detenerse varios minutos (cerca del destino, si se conoce) ofrece confirmarla en un toque
    const key = `arrive:${stopKey}`
    const nearDestination = destinationMeters == null || destinationMeters <= NEAR_DESTINATION_M
    if (position && !plant && nearDestination && stoppedMin >= STOP_MINUTES && fresh(key)) {
      return { key, text: `Parece que llegaste a ${nextName}. ¿Confirmo tu llegada?`,
        actions: [{ label: 'Confirmar llegada', run: async () => (await arrive(current, 'COPILOTO')) ? '/app/ruta' : undefined },
          { label: 'Aún no, hay demora', ask: 'Quiero reportar una demora en la entrega' }] }
    }
    return null
  }, [enabled, trip, context, moving, position, places, stoppedMin, now, seenTick, current, stops, destinationMeters, arrive, undo])

  const dismiss = useCallback((key: string) => {
    const seen = readSeen()
    seen[key] = Date.now()
    writeSeen(seen)
    setSeenTick(tick => tick + 1)
  }, [])

  return { nudge, dismiss }
}
