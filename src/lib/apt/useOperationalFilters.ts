'use client'

import { useCallback, useEffect, useMemo } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { cleanFilters } from './api'
import type { AptOperationalFilters } from './types'

export function useOperationalFilters() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const raw = params.get('of') || ''
  const filters = useMemo<AptOperationalFilters>(() => {
    try {
      const parsed = JSON.parse(raw || '{}')
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch { return {} }
  }, [raw])
  const setFilters = useCallback((next: AptOperationalFilters) => {
    const query = new URLSearchParams(params.toString())
    const clean = cleanFilters(next)
    if (Object.keys(clean).length) query.set('of', JSON.stringify(clean))
    else query.delete('of')
    router.replace(`${pathname}${query.size ? `?${query}` : ''}`, { scroll: false })
  }, [params, router, pathname])
  const hrefWith = useCallback((path: string) => raw ? `${path}?of=${encodeURIComponent(raw)}` : path, [raw])
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('jrm:context', { detail: { aptFilters: filters, aptContext: 'Inventario documental reconstruido APT; no existencia física conciliada' } }))
    return () => { window.dispatchEvent(new CustomEvent('jrm:context', { detail: { aptFilters: undefined, aptContext: undefined } })) }
  }, [filters])
  return { filters, setFilters, hrefWith, filterKey: raw, legacyFilterKey: params.get('f') }
}
