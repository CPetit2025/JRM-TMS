'use client'

import { useEffect, useSyncExternalStore } from 'react'

// Una página que muestra su propio título (PageHeader showTitle) avisa a la barra superior para no repetirlo:
// la barra conserva la sección («COMERCIAL») y la página lleva el título junto a su acción principal.
let pageOwnsTitle = false
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(l => l())

export function usePageOwnsTitle(): boolean {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => pageOwnsTitle, () => false)
}

export function useClaimPageTitle(active: boolean) {
  useEffect(() => {
    if (!active) return
    pageOwnsTitle = true; emit()
    return () => { pageOwnsTitle = false; emit() }
  }, [active])
}
