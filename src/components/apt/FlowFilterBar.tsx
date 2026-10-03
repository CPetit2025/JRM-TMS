'use client'

import { useEffect, useState } from 'react'
import { CalendarRange, RotateCcw, Search } from 'lucide-react'
import { aptApi } from '@/lib/apt/api'
import { fmtTn } from '@/lib/apt/format'
import { useFlowFilters } from '@/lib/apt/useFlowFilters'
import type { AptFilterOptions } from '@/lib/apt/types'
import { MultiSelect } from './AptFilterBar'

// Filtros del flujo multi-almacén: periodo (fecha del movimiento), cliente, OT madre y lote.
// Las fechas y los selectores aplican al instante; OT y lote al presionar Enter.

const iso = (d: Date) => d.toISOString().slice(0, 10)

function presets(): Array<{ label: string; desde?: string; hasta?: string }> {
  const t = new Date()
  const y = t.getFullYear(), m = t.getMonth()
  const first = new Date(y, m, 1)
  const prevFirst = new Date(y, m - 1, 1)
  const prevLast = new Date(y, m, 0)
  const back = (days: number) => { const d = new Date(t); d.setDate(d.getDate() - days); return d }
  return [
    { label: 'Todo' },
    { label: 'Últimos 30 días', desde: iso(back(30)) },
    { label: 'Últimos 90 días', desde: iso(back(90)) },
    { label: 'Mes actual', desde: iso(first) },
    { label: 'Mes anterior', desde: iso(prevFirst), hasta: iso(prevLast) },
    { label: 'Año', desde: `${y}-01-01` },
  ]
}

export function FlowFilterBar() {
  const { filters, setFilters, patchFilters } = useFlowFilters()
  const [opts, setOpts] = useState<AptFilterOptions | null>(null)
  useEffect(() => { aptApi.filterOptions().then(setOpts).catch(() => setOpts(null)) }, [])
  const active = Object.keys(filters).filter(k => k !== 'almacen').length > 0

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-slate-400">
          <CalendarRange className="h-3.5 w-3.5" /> Periodo
        </span>
        <input type="date" value={filters.desde || ''} onChange={e => patchFilters({ desde: e.target.value || undefined })}
          className="h-9 rounded-lg border border-slate-200 px-2 text-xs text-slate-700 outline-none focus:border-[#002855]" aria-label="Desde" />
        <span className="text-xs text-slate-400">a</span>
        <input type="date" value={filters.hasta || ''} onChange={e => patchFilters({ hasta: e.target.value || undefined })}
          className="h-9 rounded-lg border border-slate-200 px-2 text-xs text-slate-700 outline-none focus:border-[#002855]" aria-label="Hasta" />
        <select value="" onChange={e => {
            const p = presets()[Number(e.target.value)]
            if (p) patchFilters({ desde: p.desde, hasta: p.hasta })
          }}
          className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-600 outline-none focus:border-[#002855]" aria-label="Periodo rápido">
          <option value="">Rápido…</option>
          {presets().map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
        </select>
        <span className="mx-1 hidden h-6 w-px bg-slate-200 md:block" />
        <MultiSelect label="Cliente" options={(opts?.clientes || []).map(c => c.cliente)} value={filters.clientes} searchable width="w-80"
          onChange={v => patchFilters({ clientes: v })}
          render={o => <span className="flex justify-between gap-2"><span className="truncate">{o}</span><span className="shrink-0 text-slate-400">{fmtTn(opts?.clientes?.find(c => c.cliente === o)?.tn_saldo)} TN</span></span>} />
        {/* La clave reinicia los campos cuando los filtros cambian desde afuera (limpiar, enlaces) */}
        <TextFilters key={`${filters.ot || ''}|${filters.lote || ''}`} ot={filters.ot || ''} lote={filters.lote || ''}
          onApply={(o, l) => patchFilters({ ot: o.trim() || undefined, lote: l.trim() || undefined })} />
        {active && (
          <button type="button" onClick={() => setFilters(filters.almacen ? { almacen: filters.almacen } : {})}
            className="ml-auto flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-slate-500 hover:bg-slate-50 hover:text-slate-800">
            <RotateCcw className="h-3.5 w-3.5" /> Limpiar
          </button>
        )}
      </div>
    </div>
  )
}

function TextFilters({ ot: ot0, lote: lote0, onApply }: { ot: string; lote: string; onApply: (ot: string, lote: string) => void }) {
  const [ot, setOt] = useState(ot0)
  const [lote, setLote] = useState(lote0)
  const apply = () => { if (ot !== ot0 || lote !== lote0) onApply(ot, lote) }
  return (
    <form className="flex items-center gap-2" onSubmit={e => { e.preventDefault(); apply() }}>
      <input value={ot} onChange={e => setOt(e.target.value)} onBlur={apply} placeholder="OT madre (16339)"
        className="h-9 w-36 rounded-lg border border-slate-200 px-2 text-xs outline-none focus:border-[#002855]" />
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-2.5 h-3.5 w-3.5 text-slate-400" />
        <input value={lote} onChange={e => setLote(e.target.value)} onBlur={apply} placeholder="Lote contiene…"
          className="h-9 w-40 rounded-lg border border-slate-200 pl-7 pr-2 text-xs outline-none focus:border-[#002855]" />
      </div>
    </form>
  )
}
