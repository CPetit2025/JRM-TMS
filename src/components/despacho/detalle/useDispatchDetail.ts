'use client'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { DispatchDetail } from '@/lib/dispatch-detail'

/** Detalle de la parada (hitos, presencia GPS e historial); se recarga al cambiar de parada o con reload(). */
export function useDispatchDetail(dispatchId: string, requestId: string) {
  const db = useMemo(() => createClient(), [])
  const [state, setState] = useState<{ key: string; detail: DispatchDetail | null; error: string }>({ key: '', detail: null, error: '' })
  const [attempt, setAttempt] = useState(0)
  const key = `${dispatchId}/${requestId}/${attempt}`
  useEffect(() => {
    let alive = true
    void Promise.resolve(db.rpc('get_dispatch_detail', { p_dispatch: dispatchId, p_request: requestId })).then(({ data, error }) => {
      if (!alive) return
      setState(error || !data ? { key, detail: null, error: error?.message || 'No se encontró el despacho.' } : { key, detail: data as DispatchDetail, error: '' })
    }).catch(() => { if (alive) setState({ key, detail: null, error: 'No se pudo cargar el detalle del despacho.' }) })
    return () => { alive = false }
  }, [db, dispatchId, requestId, key])
  const current = state.key === key
  return { detail: current ? state.detail : null, error: current ? state.error : '', loading: !current, reload: () => setAttempt(n => n + 1) }
}
