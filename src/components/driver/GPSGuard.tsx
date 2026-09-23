"use client"

import { useEffect, type ReactNode } from 'react'
import { createClient } from '@/lib/supabase/client'
import { nativeRouteTracker } from '@/lib/native-route-tracker'
import { activeRouteKey, readRouteQueue, routeQueueKey, syncRoutePoints } from '@/lib/route-point-sync'

export default function GPSGuard({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (!navigator.geolocation) {
      window.dispatchEvent(new CustomEvent('jrm:gps-status', { detail: { state: 'unavailable' } }))
      return
    }
    const supabase = createClient()
    let stopped = false
    let driverId: string | null = null
    let dispatchId: string | null = localStorage.getItem(activeRouteKey)
    let lastTimestamp = 0
    let nativeStarted = false

    const refreshAssignment = async () => {
      const { data: userData } = await supabase.auth.getUser()
      if (!userData.user) {
        if (nativeRouteTracker) await nativeRouteTracker.stop()
        nativeStarted = false
        dispatchId = null
        localStorage.removeItem(activeRouteKey)
        return
      }
      if (stopped) return
      const { data: driver } = await supabase.from('drivers')
        .select('id, is_active').eq('profile_id', userData.user.id).maybeSingle()
      if (!driver?.is_active || stopped) {
        if (nativeRouteTracker) await nativeRouteTracker.stop()
        nativeStarted = false
        driverId = null
        dispatchId = null
        localStorage.removeItem(activeRouteKey)
        return
      }
      driverId = driver.id
      const { data: active } = await supabase.from('dispatches')
        .select('id').eq('driver_id', driver.id)
        .in('status', ['EN RUTA', 'EN_CURSO', 'RETORNO'])
        .order('created_at', { ascending: false }).limit(1).maybeSingle()
      if (active?.id) {
        dispatchId = active.id
        localStorage.setItem(activeRouteKey, active.id)
        if (nativeRouteTracker) {
          try {
            await nativeRouteTracker.start({ dispatchId: active.id, driverId: driver.id })
            nativeStarted = true
          } catch (nativeError) { console.error('No se pudo iniciar GPS nativo:', nativeError) }
        }
      } else if (navigator.onLine) {
        dispatchId = null
        localStorage.removeItem(activeRouteKey)
        if (nativeRouteTracker) {
          await nativeRouteTracker.stop()
          nativeStarted = false
        }
      }
    }

    const flush = async () => {
      if (stopped || !navigator.onLine) return
      try {
        await syncRoutePoints()
      } catch (syncError) {
        console.warn('GPS pendiente de sincronizar:', syncError)
      }
    }

    void refreshAssignment().then(flush)
    const assignmentTimer = window.setInterval(() => void refreshAssignment().then(flush), 15000)
    const flushTimer = window.setInterval(() => void flush(), 5000)
    window.addEventListener('online', flush)
    const watchId = navigator.geolocation.watchPosition(position => {
      const { latitude, longitude, accuracy, speed } = position.coords
      window.dispatchEvent(new CustomEvent('jrm:gps-status', {
        detail: { state: 'active', at: new Date(position.timestamp).toISOString(), accuracy },
      }))
      if (!driverId || !dispatchId || nativeStarted || accuracy > 30 || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return
      if (position.timestamp <= lastTimestamp) return
      lastTimestamp = position.timestamp
      const queue = readRouteQueue()
      if (queue.length >= 5000) {
        return
      }
      queue.push({ id: crypto.randomUUID(), dispatch_id: dispatchId, driver_id: driverId,
        recorded_at: new Date(position.timestamp).toISOString(), latitude, longitude,
        accuracy_m: Math.round(accuracy * 100) / 100,
        speed_mps: speed === null ? null : Math.round(speed * 100) / 100 })
      localStorage.setItem(routeQueueKey, JSON.stringify(queue))
      void flush()
    }, geoError => {
      window.dispatchEvent(new CustomEvent('jrm:gps-status', {
        detail: { state: geoError.code === 1 ? 'denied' : 'unavailable' },
      }))
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 })
    return () => {
      stopped = true
      navigator.geolocation.clearWatch(watchId)
      window.clearInterval(assignmentTimer); window.clearInterval(flushTimer)
      window.removeEventListener('online', flush)
    }
  }, [])
  return <>{children}</>
}
