'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

// Contadores de pendientes del menú (menu_pending_counts): se piden al entrar, al cambiar de pantalla y cada minuto
// mientras la pestaña está visible. Si la consulta falla, el menú simplemente no muestra contadores.

export type MenuCountTone = 'crit' | 'warn' | 'info'
export interface MenuCount { n: number; tono: MenuCountTone; texto: string; unidad?: 't' }
export type MenuCounts = Record<string, MenuCount>

const REFRESH_MS = 60_000

export function useMenuCounts(pathname: string): MenuCounts {
  const [counts, setCounts] = useState<MenuCounts>({})
  useEffect(() => {
    let alive = true
    const supabase = createClient()
    const load = async () => {
      if (typeof document !== 'undefined' && document.hidden) return
      try {
        const { data, error } = await supabase.rpc('menu_pending_counts')
        const out = data as { success?: boolean; counts?: MenuCounts } | null
        if (alive && !error && out?.success) setCounts(out.counts || {})
      } catch { /* sin contadores */ }
    }
    void load()
    const timer = window.setInterval(load, REFRESH_MS)
    const onVisible = () => { if (!document.hidden) void load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { alive = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [pathname])
  return counts
}

export const COUNT_STYLE: Record<MenuCountTone, string> = {
  crit: 'bg-[#cf152d] text-white',
  warn: 'bg-amber-300 text-amber-950',
  info: 'bg-sky-200 text-sky-900',
}

export function countLabel(c: MenuCount): string {
  if (c.unidad === 't') return `${new Intl.NumberFormat('es-PE', { maximumFractionDigits: 1 }).format(c.n)} t`
  return c.n > 99 ? '99+' : String(c.n)
}
