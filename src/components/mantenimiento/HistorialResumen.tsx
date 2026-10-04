"use client"
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, History } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { fmt, soles } from '@/lib/fleet/api'

// Centro de Control › bloque con el historial único (Excel + OT + Caja) de los últimos 12 meses. Los indicadores de
// abajo solo cuentan lo registrado en el sistema; este bloque da la foto completa y lleva a la Planificación.

type R = { total: number; correctivo: number; pct_correctivo: number | null; meta_correctivo: number; vencidos: number; proximos_30: number
  historial_hasta: string | null; planes: { activos: number; por_validar: number } | null }

export function HistorialResumen() {
  const supabase = useMemo(() => createClient(), [])
  const [r, setR] = useState<R | null>(null)
  const [alto, setAlto] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    supabase.rpc('mant_planificacion').then(({ data }) => {
      if (!alive || !data?.success) return
      setR(data.resumen)
      setAlto((data.correctivo as Array<{ plate: string; nivel: string }>).filter(c => c.nivel === 'ALTO').map(c => c.plate))
    })
    return () => { alive = false }
  }, [supabase])
  if (!r) return null
  const items: Array<[string, string, boolean]> = [
    ['Gasto 12 meses', soles(r.total), false],
    ['Correctivo', r.pct_correctivo != null ? `${r.pct_correctivo} %` : '—', (r.pct_correctivo ?? 0) > r.meta_correctivo],
    ['Preventivos vencidos', fmt(r.vencidos), r.vencidos > 0],
    ['Próximos 30 días', fmt(r.proximos_30), false],
    ['Unidades en riesgo alto', fmt(alto.length), alto.length > 0],
    ['Planes sin activar', fmt(r.planes?.por_validar ?? 0), (r.planes?.por_validar ?? 0) > 0],
  ]
  return (
    <div className="rounded-xl border border-[#002855]/20 bg-white p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-semibold text-slate-800"><History className="h-4 w-4 text-[#002855]" />Con el historial completo (Excel + OT + Caja)</h3>
        <Link href="/mantenimiento/plan-anual" className="flex items-center gap-1 text-sm font-semibold text-[#002855] hover:underline">Ver planificación <ArrowRight className="h-4 w-4" /></Link>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        {items.map(([k, v, bad]) => <div key={k}><div className="text-xs text-slate-500">{k}</div><div className={`truncate text-lg font-bold ${bad ? 'text-[#cf152d]' : 'text-slate-900'}`}>{v}</div></div>)}
      </div>
      {alto.length > 0 && <p className="mt-1 text-xs text-slate-600">Riesgo alto: {alto.join(', ')}</p>}
      {r.historial_hasta && <p className="mt-2 text-[11px] text-slate-400">El historial del Excel llega hasta {new Date(`${r.historial_hasta}T12:00:00`).toLocaleDateString('es-PE')}. Los indicadores de abajo solo cuentan OT, fallas y costos registrados en el sistema.</p>}
    </div>
  )
}

// Preventivos › aviso de planes creados desde las plantillas que aún no se activan
export function PlanesPorActivarAviso() {
  const supabase = useMemo(() => createClient(), [])
  const [n, setN] = useState(0)
  useEffect(() => {
    let alive = true
    supabase.from('maintenance_plans').select('id', { count: 'exact', head: true }).eq('is_active', false).not('mant_template_id', 'is', null)
      .then(({ count }) => { if (alive) setN(count || 0) })
    return () => { alive = false }
  }, [supabase])
  if (!n) return null
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <span><b>{n} planes preventivos creados desde el historial están sin activar</b>, por eso no aparecen en la proyección ni generan OT.</span>
      <Link href="/mantenimiento/plan-anual?tab=preventivo" className="font-semibold text-[#002855] hover:underline">Revisar y activar →</Link>
    </div>
  )
}
