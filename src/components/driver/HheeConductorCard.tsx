'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronRight, Timer } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

type Item = { request_id: string; approval: string; actual_end: string | null; can_close: boolean }

/** Acceso a Mis horas extras en Inicio; resalta las aprobadas que siguen abiertas. */
export function HheeConductorCard() {
  const supabase = useMemo(() => createClient(), [])
  const [open, setOpen] = useState(0)
  useEffect(() => {
    let alive = true
    void supabase.rpc('hhee_driver_overtime').then(({ data }) => {
      const items = ((data as { items?: Item[] } | null)?.items || [])
      if (alive) setOpen(items.filter(i => !i.actual_end && i.approval === 'APROBADA').length)
    }, () => {})
    return () => { alive = false }
  }, [supabase])
  return <Link href="/app/hhee" className={`flex min-h-14 items-center gap-3 rounded-xl border p-4 text-sm font-semibold ${open ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-slate-200 bg-white text-[#002855]'}`}>
    <Timer className="h-5 w-5 shrink-0" />
    <span>Mis horas extras{open > 0 && <small className="block font-normal">{open} aprobada(s) en curso · ciérralas al terminar</small>}</span>
    <ChevronRight className="ml-auto h-5 w-5 shrink-0" />
  </Link>
}
