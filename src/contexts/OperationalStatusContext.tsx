'use client'

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { nativeRouteTracker } from '@/lib/native-route-tracker'
import { readActionQueue, readRouteQueue, syncOfflineActions, syncRoutePoints } from '@/lib/route-point-sync'

type GpsState = 'checking' | 'active' | 'unavailable' | 'denied'
type OperationalStatus = {
  online: boolean
  gps: GpsState
  lastGpsAt: string | null
  pendingSync: number
  syncing: boolean
  syncNow: () => Promise<void>
}

const Context = createContext<OperationalStatus>({
  online: true, gps: 'checking', lastGpsAt: null, pendingSync: 0, syncing: false,
  syncNow: async () => {},
})

export function OperationalStatusProvider({ children }: { children: React.ReactNode }) {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' ? true : navigator.onLine)
  const [gps, setGps] = useState<GpsState>('checking')
  const [lastGpsAt, setLastGpsAt] = useState<string | null>(null)
  const [pendingSync, setPendingSync] = useState(0)
  const [syncing, setSyncing] = useState(false)

  const countPending = useCallback(async () => {
    const nativeCount = nativeRouteTracker ? (await nativeRouteTracker.pending().catch(() => ({ points: [] }))).points.length : 0
    setPendingSync(readRouteQueue().length + readActionQueue().length + nativeCount)
  }, [])

  const syncNow = useCallback(async () => {
    if (!navigator.onLine) return
    setSyncing(true)
    await Promise.allSettled([syncRoutePoints(), syncOfflineActions()])
    await countPending()
    setSyncing(false)
  }, [countPending])

  useEffect(() => {
    const initial = window.setTimeout(() => void countPending(), 0)
    const onOnline = () => { setOnline(true); void syncNow() }
    const onOffline = () => setOnline(false)
    const onGps = (event: Event) => {
      const detail = (event as CustomEvent<{ state: GpsState; at?: string }>).detail
      setGps(detail.state)
      if (detail.at) setLastGpsAt(detail.at)
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    window.addEventListener('jrm:gps-status', onGps)
    const timer = window.setInterval(() => void countPending(), 5_000)
    return () => {
      window.clearTimeout(initial)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('jrm:gps-status', onGps)
      window.clearInterval(timer)
    }
  }, [countPending, syncNow])

  return <Context.Provider value={{ online, gps, lastGpsAt, pendingSync, syncing, syncNow }}>{children}</Context.Provider>
}

export function useOperationalStatus() {
  return useContext(Context)
}
