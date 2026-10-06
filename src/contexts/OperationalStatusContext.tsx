'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { db } from '@/lib/offline/db'
import { syncOwnPreuse } from '@/lib/offline/preuse-runtime'
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
  const supabase = useMemo(() => createClient(), [])
  const [online, setOnline] = useState(true)
  const [gps, setGps] = useState<GpsState>('checking')
  const [lastGpsAt, setLastGpsAt] = useState<string | null>(null)
  const [pendingSync, setPendingSync] = useState(0)
  const [syncing, setSyncing] = useState(false)

  const countPending = useCallback(async () => {
    const nativeCount = nativeRouteTracker ? (await nativeRouteTracker.pending().catch(() => ({ points: [] }))).points.length : 0
    const { data } = await supabase.auth.getSession()
    const ownPreuse = data.session?.user.id ? await db.preuse.where('profile_id').equals(data.session.user.id).filter(row => row.synced === 0).count() : 0
    setPendingSync(readRouteQueue().length + readActionQueue().length + nativeCount + ownPreuse)
  }, [supabase])

  const syncNow = useCallback(async () => {
    if (!navigator.onLine) return
    setSyncing(true)
    await Promise.allSettled([syncRoutePoints(), syncOfflineActions(), syncOwnPreuse(supabase)])
    await countPending()
    setSyncing(false)
  }, [countPending, supabase])

  useEffect(() => {
    const initial = window.setTimeout(() => { setOnline(navigator.onLine); void countPending() }, 0)
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
    const onPreuse = () => { void countPending() }
    window.addEventListener('jrm:preuse-queue-changed', onPreuse)
    const timer = window.setInterval(() => void countPending(), 5_000)
    return () => {
      window.clearTimeout(initial)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('jrm:gps-status', onGps)
      window.removeEventListener('jrm:preuse-queue-changed', onPreuse)
      window.clearInterval(timer)
    }
  }, [countPending, syncNow])

  return <Context.Provider value={{ online, gps, lastGpsAt, pendingSync, syncing, syncNow }}>{children}</Context.Provider>
}

export function useOperationalStatus() {
  return useContext(Context)
}
