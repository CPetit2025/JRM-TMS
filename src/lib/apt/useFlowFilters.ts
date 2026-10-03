'use client'

import { useCallback, useMemo } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { cleanFilters } from './api'
import type { FlowFilters } from './flowTypes'

// Filtros del flujo multi-almacén en la URL (?ff=<json>), separados de los de la estadía (?f=) porque miden otra cosa:
// aquí el periodo es la fecha del movimiento (producción, traspaso o guía), no la fecha de ingreso a APT.
function parse(raw: string | null): FlowFilters {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as FlowFilters) : {}
  } catch {
    return {}
  }
}

export function useFlowFilters() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const raw = searchParams.get('ff')
  const filters = useMemo(() => parse(raw), [raw])

  const setFilters = useCallback((next: FlowFilters) => {
    const clean = cleanFilters(next)
    const qs = new URLSearchParams(searchParams.toString())
    if (Object.keys(clean).length) qs.set('ff', JSON.stringify(clean))
    else qs.delete('ff')
    const s = qs.toString()
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false })
  }, [pathname, router, searchParams])

  const patchFilters = useCallback((patch: Partial<FlowFilters>) => setFilters({ ...filters, ...patch }), [filters, setFilters])

  // Enlace a otra pantalla del flujo conservando los filtros (y opcionalmente agregando otros)
  const hrefWith = useCallback((path: string, extra?: Partial<FlowFilters>) => {
    const f = cleanFilters({ ...filters, ...(extra || {}) })
    return Object.keys(f).length ? `${path}?ff=${encodeURIComponent(JSON.stringify(f))}` : path
  }, [filters])

  return { filters, setFilters, patchFilters, hrefWith, filterKey: raw || '' }
}

// Ficha de trazabilidad de una guía o un lote
export const traceHref = (q: string) => `/apt/flujo/trazabilidad?q=${encodeURIComponent(q)}`
