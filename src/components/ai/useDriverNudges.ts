'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

// Avisos proactivos del copiloto para el conductor. Se evalúan con su viaje activo (get_active_trip_context), el GPS del
// teléfono y la geocerca de planta (authorized_locations). Las paradas no tienen coordenadas, así que la "llegada" se
// detecta cuando la unidad lleva varios minutos detenida durante la ruta. Cada aviso se muestra una vez (o tras un
// tiempo de espera) y el conductor confirma en su pantalla; el copiloto no registra nada por su cuenta.

export type NudgeAction = { label: string; href?: string; ask?: string }
export type Nudge = { key: string; text: string; actions: NudgeAction[] }

type Stop = { status?: string; delivery_address?: string | null; request_number?: string | null }
type Trip = { id: string; status: string; vehicle_plate?: string | null; scheduled_departure?: string | null; stops?: Stop[] }
type TripContext = { trip: Trip | null; pending?: { checklist?: boolean; stops?: number } }
type Place = { name: string; latitude: number; longitude: number; radius_km: number }

const STOP_MINUTES = 4            // detenido este tiempo durante la ruta → probable llegada
const STOP_RADIUS_M = 120         // movimiento máximo para considerar la unidad detenida
const COOLDOWN_MS = 15 * 60_000   // un aviso descartado vuelve a mostrarse pasado este tiempo
const STORE = 'jrm-ai-nudges'

const meters = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const r = 6_371_000, rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * r * Math.asin(Math.sqrt(h))
}
const readSeen = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(STORE) || '{}') } catch { return {} } }
const writeSeen = (seen: Record<string, number>) => { try { localStorage.setItem(STORE, JSON.stringify(seen)) } catch { /* sin almacenamiento */ } }

export function useDriverNudges(enabled: boolean) {
  const supabase = useMemo(() => createClient(), [])
  const [context, setContext] = useState<TripContext | null>(null)
  const [places, setPlaces] = useState<Place[]>([])
  const [position, setPosition] = useState<{ lat: number; lon: number } | null>(null)
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
    void load()
    supabase.from('authorized_locations').select('name, latitude, longitude, radius_km').eq('is_active', true)
      .then(({ data }) => { if (!cancelled) setPlaces((data as Place[]) || []) })
    const timer = window.setInterval(() => { void load(); setNow(Date.now()) }, 60_000)
    const onChange = () => void load()
    window.addEventListener('jrm:trip-changed', onChange)
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener('jrm:trip-changed', onChange) }
  }, [enabled, supabase])

  const trip = context?.trip || null
  const moving = !!trip && ['EN RUTA', 'EN_CURSO', 'RETORNO'].includes(trip.status)

  // GPS solo mientras la unidad está en ruta
  useEffect(() => {
    if (!enabled || !moving || typeof navigator === 'undefined' || !navigator.geolocation) return
    const id = navigator.geolocation.watchPosition(pos => {
      const here = { lat: pos.coords.latitude, lon: pos.coords.longitude }
      setPosition(here)
      setNow(Date.now())
      if (!anchor.current || meters(anchor.current, here) > STOP_RADIUS_M) {
        anchor.current = here
        setStoppedSince(Date.now())
      }
    }, () => undefined, { enableHighAccuracy: true, maximumAge: 30_000, timeout: 20_000 })
    return () => navigator.geolocation.clearWatch(id)
  }, [enabled, moving])

  const nudge = useMemo<Nudge | null>(() => {
    void seenTick
    if (!enabled || !trip) return null
    const seen = readSeen()
    const fresh = (key: string) => !seen[key] || now - seen[key] > COOLDOWN_MS
    const plate = trip.vehicle_plate ? ` ${trip.vehicle_plate}` : ''
    const stops = trip.stops || []
    const next = stops.find(stop => stop.status !== 'ENTREGADO')
    const nextName = next?.delivery_address || next?.request_number || 'tu próxima parada'
    const pendingStops = context?.pending?.stops ?? stops.filter(stop => stop.status !== 'ENTREGADO').length

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
    if (pendingStops === 0) {
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
    const stoppedMin = stoppedSince ? (now - stoppedSince) / 60_000 : 0
    const stopIndex = stops.indexOf(next as Stop)
    const key = `arrive:${trip.id}:${stopIndex}`
    if (position && !plant && stoppedMin >= STOP_MINUTES && fresh(key)) {
      return { key, text: `Parece que llegaste a ${nextName}. ¿Confirmamos tu llegada y la entrega?`,
        actions: [{ label: 'Confirmar en mi ruta', href: '/app/ruta' }, { label: 'Aún no, hay demora', ask: 'Quiero reportar una demora en la entrega' }] }
    }
    return null
  }, [enabled, trip, context, moving, position, places, stoppedSince, now, seenTick])

  const dismiss = useCallback((key: string) => {
    const seen = readSeen()
    seen[key] = Date.now()
    writeSeen(seen)
    setSeenTick(tick => tick + 1)
  }, [])

  return { nudge, dismiss }
}
