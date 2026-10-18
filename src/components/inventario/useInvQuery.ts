'use client'

import { useCallback, useEffect, useState } from 'react'
import { INV_UPDATED } from '@/lib/inventario/api'

// Lectura con estado de carga/error que se repite al cambiar la clave o cuando se aplica una carga o un recálculo
export function useInvQuery<T>(key: string, fetcher: () => Promise<T>) {
  const [nonce, setNonce] = useState(0)
  const [res, setRes] = useState<{ key: string; data: T | null; error: string | null } | null>(null)
  const full = `${key}|${nonce}`
  useEffect(() => {
    let alive = true
    fetcher().then(data => { if (alive) setRes({ key: full, data, error: null }) })
      .catch((e: Error) => { if (alive) setRes({ key: full, data: null, error: e.message }) })
    return () => { alive = false }
    // fetcher cambia en cada render; la clave describe sus argumentos
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full])
  useEffect(() => {
    const up = () => setNonce(n => n + 1)
    window.addEventListener(INV_UPDATED, up)
    return () => window.removeEventListener(INV_UPDATED, up)
  }, [])
  const reload = useCallback(() => setNonce(n => n + 1), [])
  const current = res?.key === full
  return { data: current ? res.data : null, error: current ? res.error : null, loading: !current, reload }
}
