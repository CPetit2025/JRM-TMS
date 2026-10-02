'use client'

import { useCallback, useMemo } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { cleanFilters } from './api'
import type { AptFilters } from './types'

// Los filtros del módulo viven en la URL (?f=<json>): se comparten entre pestañas, sobreviven a recargar
// y permiten bajar del dashboard al lote o al detalle sin perder el contexto.
function parse(raw: string | null): AptFilters {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as AptFilters) : {}
  } catch {
    return {}
  }
}

export function useAptFilters() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const raw = searchParams.get('f')
  const filters = useMemo(() => parse(raw), [raw])

  const setFilters = useCallback((next: AptFilters) => {
    const clean = cleanFilters(next)
    const qs = new URLSearchParams(searchParams.toString())
    if (Object.keys(clean).length) qs.set('f', JSON.stringify(clean))
    else qs.delete('f')
    const s = qs.toString()
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false })
  }, [pathname, router, searchParams])

  const patchFilters = useCallback((patch: Partial<AptFilters>) => setFilters({ ...filters, ...patch }), [filters, setFilters])

  // Enlace a otra pantalla del módulo conservando los filtros (y opcionalmente agregando otros)
  const hrefWith = useCallback((path: string, extra?: Partial<AptFilters>) => {
    const f = cleanFilters({ ...filters, ...(extra || {}) })
    return Object.keys(f).length ? `${path}?f=${encodeURIComponent(JSON.stringify(f))}` : path
  }, [filters])

  return { filters, setFilters, patchFilters, hrefWith, filterKey: raw || '' }
}

export const loteHref = (lote: string, f?: AptFilters) => {
  const clean = f ? cleanFilters(f) : {}
  const q = Object.keys(clean).length ? `?f=${encodeURIComponent(JSON.stringify(clean))}` : ''
  return `/apt/lote/${encodeURIComponent(lote)}${q}`
}
