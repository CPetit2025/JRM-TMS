'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

// Stale-while-revalidate cache in sessionStorage, scoped per user. Only plain JSON data.
const TTL_MS = 5 * 60_000
const MAX_CHARS = 1_500_000 // ~3 MB as UTF-16; bigger payloads are not cached

async function storageKey(key: string) {
  const { data } = await createClient().auth.getSession()
  const uid = data.session?.user.id
  return uid ? `wms-cache:${uid}:${key}` : null
}

export async function readCache<T>(key: string): Promise<T | undefined> {
  try {
    const k = await storageKey(key)
    const raw = k ? sessionStorage.getItem(k) : null
    if (!k || !raw) return undefined
    const { at, data } = JSON.parse(raw) as { at: number; data: T }
    if (Date.now() - at > TTL_MS) { sessionStorage.removeItem(k); return undefined }
    return data
  } catch { return undefined }
}

export async function writeCache(key: string, data: unknown) {
  try {
    const k = await storageKey(key)
    if (!k) return
    const raw = JSON.stringify({ at: Date.now(), data })
    if (raw.length > MAX_CHARS) sessionStorage.removeItem(k); else sessionStorage.setItem(k, raw)
  } catch { /* quota or private mode: run without cache */ }
}

/** Shows the cached value at once (if fresh) and always refetches in background. fetcher must be stable (useCallback). */
export function useCached<T>(key: string, fetcher: () => Promise<T>) {
  const [data, setData] = useState<T | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const fresh = useRef(false)
  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const next = await fetcher()
      fresh.current = true
      setData(next); setError('')
      void writeCache(key, next)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    setLoading(false)
  }, [key, fetcher])
  useEffect(() => {
    fresh.current = false
    void readCache<T>(key).then(cached => { if (cached !== undefined && !fresh.current) setData(cached) })
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload()
  }, [key, reload])
  return { data, loading, error, reload, setData }
}
