"use client"
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, Download, Layers, PiggyBank, Percent, RefreshCw, Search } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { KpiStatCard } from '@/components/ui/kpi-stat-card'
import { errorMessage, money } from '@/lib/caja'
import { ControlPresupuestalTabs } from '@/components/despacho/ControlPresupuestalTabs'
import { HourCostsEditor, SavingsTable, exportSavingsCsv, type SavingsResult } from '@/components/despacho/ConsolidationSavings'

// Reporte del ahorro por consolidación: servicios aprovechados en rutas compartidas, valorizados con el tarifario y
// comparados con su costo marginal. Indicador de eficiencia; no toca la partida (docs/control-presupuestal/ahorro-consolidacion.md).

const supabase = createClient()
const lima = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
const TYPES: Record<string, string> = { DESPACHO: 'Entregas', RECOJO: 'Recojos', TRASLADO: 'Traslados' }

function Ahorro() {
  const params = useSearchParams(); const router = useRouter(); const path = usePathname()
  const today = lima(new Date())
  const from = params.get('desde') || `${today.slice(0, 8)}01`, to = params.get('hasta') || today
  const type = params.get('tipo') || '', q = (params.get('q') || '').toLowerCase()
  const [data, setData] = useState<SavingsResult | null>(null)
  const [search, setSearch] = useState(params.get('q') || '')
  // Los filtros viven en la dirección: se conservan al abrir un viaje y volver
  const set = useCallback((changes: Record<string, string>) => {
    const next = new URLSearchParams(params.toString())
    for (const [k, v] of Object.entries(changes)) { if (v) next.set(k, v); else next.delete(k) }
    router.replace(`${path}?${next.toString()}`, { scroll: false })
  }, [params, path, router])
  const load = useCallback(async () => {
    const { data: d, error } = await supabase.rpc('consolidation_savings', { p_from: from, p_to: to })
    if (error || !d?.success) { toast.error(error ? errorMessage(error) : d?.error); setData(null); return }
    setData(d as SavingsResult)
  }, [from, to])
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [load])
  useEffect(() => { const t = window.setTimeout(() => { if (search.toLowerCase() !== q) set({ q: search }) }, 400); return () => window.clearTimeout(t) }, [search, q, set])

  const rows = useMemo(() => (data?.rows || []).filter(r => (!type || r.request_type === type)
    && (!q || `${r.dispatch_number} ${r.request_number} ${r.contract_code || ''} ${r.root_code || ''} ${r.client || ''} ${r.district || ''}`.toLowerCase().includes(q))), [data, type, q])
  const leveraged = rows.filter(r => !r.principal)
  const total = leveraged.reduce((s, r) => s + Number(r.saving_pen || 0), 0)
  const rate = data?.services_total ? Math.round(1000 * data.leveraged / data.services_total) / 10 : null

  return (
    <div className="min-w-0 space-y-3">
      <PageHeader showTitle title="Control presupuestal" description="Ahorro por consolidación: cuánto costarían los servicios aprovechados con su propio viaje y cuánto costaron dentro de la ruta."
        actions={<><button type="button" onClick={() => void load()} className="flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm hover:bg-slate-50"><RefreshCw className="h-4 w-4" />Actualizar</button>
          <button type="button" disabled={!rows.length} onClick={() => exportSavingsCsv(rows)} className="flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm hover:bg-slate-50 disabled:opacity-50"><Download className="h-4 w-4" />Exportar</button></>} />
      <ControlPresupuestalTabs active="ahorro" />

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs font-semibold text-slate-600">Desde<input type="date" value={from} onChange={e => set({ desde: e.target.value })} className="mt-1 block h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm" /></label>
        <label className="text-xs font-semibold text-slate-600">Hasta<input type="date" value={to} onChange={e => set({ hasta: e.target.value })} className="mt-1 block h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm" /></label>
        <label className="text-xs font-semibold text-slate-600">Tipo de servicio
          <select value={type} onChange={e => set({ tipo: e.target.value })} className="mt-1 block h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm">
            <option value="">Todos</option>{Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="relative block w-72 max-w-full"><span className="sr-only">Buscar</span><Search aria-hidden className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="OT, cliente, ruta, solicitud o distrito…" className="h-9 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm" /></label>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <KpiStatCard label="Ahorro del período (filtrado)" value={data ? `S/ ${money(total)}` : '—'} tone="emerald" icon={<PiggyBank className="h-5 w-5" />} loading={!data} />
        <KpiStatCard label="Servicios aprovechados" value={leveraged.length} tone="navy" icon={<Layers className="h-5 w-5" />} loading={!data} />
        <KpiStatCard label="Tasa de aprovechamiento (período)" value={rate == null ? '—' : `${rate} %`} tone="amber" icon={<Percent className="h-5 w-5" />} loading={!data} />
      </div>
      {data?.hours_cost_missing && <p className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"><AlertTriangle className="h-4 w-4" />
        Faltan costos por hora: las horas extra de esos servicios no suman al costo marginal (el ahorro sale mayor). Cárguelos abajo.</p>}

      <div className="rounded-xl border border-slate-200 bg-white">{!data ? <p className="p-6 text-center text-sm text-slate-500">Cargando…</p> : <SavingsTable rows={rows} />}</div>
      <HourCostsEditor onSaved={() => void load()} />
      <p className="text-[11px] text-slate-500">Valor independiente: tarifa del tarifario al distrito con la clase de unidad que pide el peso (o la de la unidad de la ruta). Costo marginal: flota propia, combustible de los km extra + horas extra × (unidad + tripulación) + peajes; tercero, flete pagado por el servicio + peajes. Ahorro negativo = no convino aprovecharlo. No consume la partida.</p>
    </div>
  )
}

export default function AhorroPage() {
  return <Suspense fallback={null}><Ahorro /></Suspense>
}
