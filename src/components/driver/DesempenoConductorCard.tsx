'use client'

import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Gauge } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

// App del conductor › Inicio: «Mi desempeño del mes» (conductor_mi_desempeno, migración 20261005180000).
// Muestra el índice del mes en curso, lo que le falta mejorar y el resultado del mes anterior. Solo ve su propio resultado.

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const CALIF: Record<string, [string, string]> = {
  EXCELENTE: ['Excelente', 'bg-emerald-100 text-emerald-800'], BUENO: ['Bueno', 'bg-sky-100 text-sky-800'],
  REGULAR: ['Regular', 'bg-amber-100 text-amber-800'], BAJO: ['Bajo', 'bg-red-100 text-red-800'], SIN_DATOS: ['Aún sin datos suficientes', 'bg-slate-100 text-slate-600'],
}
const valor = (k: Row) => k.valor == null ? '—' : k.unidad === '%' ? `${Math.round(Number(k.valor))} %` : String(Math.round(Number(k.valor) * 10) / 10)

export function DesempenoConductorCard() {
  const supabase = useMemo(() => createClient(), [])
  const [d, setD] = useState<Row | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let alive = true
    supabase.rpc('conductor_mi_desempeno', { p_mes: null }).then(({ data }) => { if (alive && data?.success) setD(data) })
    return () => { alive = false }
  }, [supabase])
  if (!d) return null
  const k = d.actual || {}, ant = d.anterior || {}
  const [label, cls] = CALIF[k.calificacion] || CALIF.SIN_DATOS
  const mejorar: Row[] = (k.kpis || []).filter((x: Row) => x.puntaje != null && x.puntaje < 90).sort((a: Row, b: Row) => a.puntaje - b.puntaje).slice(0, 3)
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <button type="button" onClick={() => setOpen(o => !o)} className="flex w-full items-center gap-3 text-left">
        <span className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-2xl bg-[#002855] text-white">
          <span className="text-xl font-black leading-none">{k.indice ?? '—'}</span><span className="text-[9px] opacity-70">/ 100</span>
        </span>
        <span className="flex-1">
          <span className="flex items-center gap-1.5 font-black text-slate-800"><Gauge className="h-4 w-4 text-[#002855]" />Mi desempeño del mes</span>
          <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>{label}</span>
          {ant.indice != null && <span className="ml-2 text-xs text-slate-500">Mes anterior: {ant.indice}</span>}
        </span>
        <ChevronDown className={`h-5 w-5 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {k.siniestro_grave && <p className="mt-3 rounded-xl bg-red-50 p-2 text-xs text-red-800">Siniestro grave este mes: el índice queda en 0.</p>}
      {mejorar.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <p className="text-xs font-bold uppercase text-slate-400">Por mejorar</p>
          {mejorar.map(x => <div key={x.codigo} className="flex justify-between rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900"><span>{x.nombre}</span><b>{valor(x)}{x.contexto ? <span className="ml-1 text-[11px] font-normal">({x.contexto})</span> : null}</b></div>)}
        </div>
      )}
      {open && (
        <div className="mt-3 divide-y text-sm">
          {(k.kpis || []).filter((x: Row) => x.peso > 0).map((x: Row) => (
            <div key={x.codigo} className="flex items-center justify-between py-1.5">
              <span className="text-slate-600">{x.nombre}</span>
              <span className={`font-semibold ${x.puntaje == null ? 'text-slate-400' : x.puntaje >= 90 ? 'text-emerald-700' : x.puntaje >= 70 ? 'text-amber-700' : 'text-red-700'}`}>{valor(x)}</span>
            </div>
          ))}
          <p className="pt-2 text-[11px] text-slate-400">Se calcula solo con tus viajes, checklist, evidencias, gastos, multas y siniestros del mes. El día 1 te llega tu resultado.</p>
        </div>
      )}
    </section>
  )
}
