"use client"

import { useEffect, useState, type ReactNode } from 'react'
import { MapPinOff, Loader2, Navigation } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { nativeRouteTracker } from '@/lib/native-route-tracker'
import { activeRouteKey, readRouteQueue, routeQueueKey, syncRoutePoints } from '@/lib/route-point-sync'

export default function GPSGuard({ children }: { children: ReactNode }) {
  const [permissionGranted, setPermissionGranted] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isChecking, setIsChecking] = useState(true)
  const [unsent, setUnsent] = useState(0)

  useEffect(() => {
    if (!navigator.geolocation) {
      setError('Geolocalización no soportada por este dispositivo.')
      setIsChecking(false)
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
        setUnsent(await syncRoutePoints())
      } catch (syncError) {
        console.warn('GPS pendiente de sincronizar:', syncError)
      }
    }

    void refreshAssignment().then(flush)
    const assignmentTimer = window.setInterval(() => void refreshAssignment().then(flush), 15000)
    const flushTimer = window.setInterval(() => void flush(), 5000)
    window.addEventListener('online', flush)
    const watchId = navigator.geolocation.watchPosition(position => {
      setPermissionGranted(true); setIsChecking(false); setError(null)
      const { latitude, longitude, accuracy, speed } = position.coords
      if (!driverId || !dispatchId || nativeStarted || accuracy > 30 || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return
      if (position.timestamp <= lastTimestamp) return
      lastTimestamp = position.timestamp
      const queue = readRouteQueue()
      if (queue.length >= 5000) {
        setError('Memoria GPS llena. Conecta el dispositivo a Internet para sincronizar la ruta.')
        return
      }
      queue.push({ id: crypto.randomUUID(), dispatch_id: dispatchId, driver_id: driverId,
        recorded_at: new Date(position.timestamp).toISOString(), latitude, longitude,
        accuracy_m: Math.round(accuracy * 100) / 100,
        speed_mps: speed === null ? null : Math.round(speed * 100) / 100 })
      localStorage.setItem(routeQueueKey, JSON.stringify(queue))
      setUnsent(queue.length)
      void flush()
    }, geoError => {
      setIsChecking(false); setPermissionGranted(false)
      setError(geoError.code === 1 ? 'Permiso de ubicación denegado.' : 'Señal GPS no disponible.')
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 })
    return () => {
      stopped = true
      navigator.geolocation.clearWatch(watchId)
      window.clearInterval(assignmentTimer); window.clearInterval(flushTimer)
      window.removeEventListener('online', flush)
    }
  }, [])

  const requestPermission = () => {
    setIsChecking(true)
    navigator.geolocation.getCurrentPosition(
      () => { setPermissionGranted(true); setIsChecking(false); setError(null) },
      () => { setPermissionGranted(false); setIsChecking(false); setError('Debes permitir el GPS en la configuración del dispositivo.') },
      { enableHighAccuracy: true, timeout: 15000 }
    )
  }
  if (isChecking) return <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center text-white gap-3"><Loader2 className="animate-spin" />Verificando GPS...</div>
  if (permissionGranted === false || error) return <div className="min-h-screen bg-red-950 flex flex-col items-center justify-center p-6 text-center text-white gap-4">
    <MapPinOff className="w-12 h-12 text-red-400" /><h1 className="text-2xl font-bold">GPS no disponible</h1>
    <p className="max-w-sm">{error || 'Activa la ubicación para usar el portal operativo.'}</p>
    <button onClick={requestPermission} className="bg-white text-red-900 px-6 py-3 rounded-xl font-bold flex gap-2"><Navigation />Reintentar GPS</button>
  </div>
  return <>{children}<div className="fixed top-4 left-1/2 -translate-x-1/2 bg-green-600 text-white text-xs font-bold px-3 py-1 rounded-full shadow z-50 pointer-events-none">
    GPS activo{unsent > 0 ? ` · ${unsent} puntos pendientes` : ''}
  </div></>
}
