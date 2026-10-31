"use client"
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, CheckCircle2, ClipboardCheck, Clock, Eye, FileText, Hourglass, RefreshCw, Search, ShieldCheck, Wallet, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { KpiStatCard } from '@/components/ui/kpi-stat-card'
import { TablePagination } from '@/components/ui/table-pagination'
import { TableActions, type TableAction } from '@/components/ui/table-actions'
import { errorMessage, money } from '@/lib/caja'
import { dispatchStatusLabel } from '@/lib/dispatch-status'
import {
  DEFAULT_SETTINGS, DOC_STATUS, ECON_STATUS, ITEM_LABEL, documentaryHref, econKey, isDeviation, pendingText, routeSummary,
  type EconRoute, type EconSettings,
} from '@/lib/economic-closure'
import { EconomicClosurePanel, Variation } from '@/components/despacho/EconomicClosurePanel'
import { ServiceCostIndicators } from '@/components/despacho/ServiceCostIndicators'

// Cierre económico por ruta, separado del cierre documentario: bandeja con indicadores, estado documentario y económico,
// proveedor principal, variación acordado → final (en rojo sobre el umbral configurable), pendientes, responsable y
// última actualización; filtros, orden y paginación. El detalle se abre en un panel lateral.

const supabase = createClient()
const limaDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : '—')
const fmtDateTime = (v: string | null) => (v ? new Date(v).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' }) : '—')
type Sort = 'fecha' | 'monto' | 'desviacion' | 'antiguedad' | 'pendientes'
const SORTS: [Sort, string][] = [['fecha', 'Fecha (recientes)'], ['monto', 'Monto acordado'], ['desviacion', 'Mayor desviación'], ['antiguedad', 'Antigüedad'], ['pendientes', 'N.º de pendientes']]
const select = 'h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-700'

function Badge({ map, value }: { map: Record<string, { label: string; cls: string }>; value: string }) {
  const s = map[value] || { label: value, cls: 'bg-slate-100 text-slate-600' }
  return <span className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-[11px] font-semibold ${s.cls}`}>{s.label}</span>
}

export default function CierreEconomicoPage() {
  return <Suspense fallback={null}><CierreEconomico /></Suspense>
}

function CierreEconomico() {
  const router = useRouter()
  // ?despacho=<id> (desde Documentos de Despacho): abre directamente la validación de esa ruta
  const linked = useSearchParams().get('despacho')
  const today = new Date()
  const [from, setFrom] = useState(limaDate(new Date(today.getFullYear(), today.getMonth(), 1)))
  const [to, setTo] = useState(limaDate(today))
  const [routes, setRoutes] = useState<EconRoute[] | null>(null)
  const [perm, setPerm] = useState({ validate: false, approve: false })
  const [settings, setSettings] = useState<EconSettings>(DEFAULT_SETTINGS)
  const [view, setView] = useState<'bandeja' | 'indicadores'>('bandeja')
  const [open, setOpen] = useState<{ id: string; tab: 'resumen' | 'servicios' } | null>(() => (linked && /^[0-9a-f-]{36}$/i.test(linked) ? { id: linked, tab: 'servicios' } : null))
  // La bandeja incluye la fecha de la ruta enlazada aunque sea anterior al período por defecto
  useEffect(() => {
    if (!linked || !/^[0-9a-f-]{36}$/i.test(linked)) return
    let alive = true
    void supabase.from('dispatches').select('scheduled_departure').eq('id', linked).maybeSingle().then(({ data }) => {
      const day = data?.scheduled_departure ? limaDate(new Date(data.scheduled_departure)) : null
      if (alive && day) setFrom(current => (day < current ? day : current))
    })
    return () => { alive = false }
  }, [linked])
  const [f, setF] = useState({ q: '', econ: '', doc: '', supplier: '', concept: '', contract: '', plate: '', responsible: '' })
  const [sort, setSort] = useState<Sort>('fecha')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('economic_closure_queue', { p_from: from, p_to: to })
    if (error || !data?.success) { toast.error(error ? errorMessage(error) : data?.error); setRoutes([]); return }
    setRoutes(data.routes as EconRoute[])
    setPerm({ validate: !!data.can_validate, approve: !!data.can_approve })
    if (data.settings) setSettings(data.settings as EconSettings)
  }, [from, to])
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [load])
  const setFilter = (patch: Partial<typeof f>) => { setF(prev => ({ ...prev, ...patch })); setPage(1) }

  const rows = useMemo(() => (routes || []).map(r => ({ r, s: routeSummary(r), key: econKey(r) })), [routes])
  const kpis = useMemo(() => {
    const count = (k: string) => rows.filter(x => x.key === k).length
    const withFinal = rows.reduce((a, x) => a + x.s.agreedWithFinal, 0)
    const variation = rows.reduce((a, x) => a + x.s.variation, 0)
    return {
      pending: count('PENDIENTE') + count('RUTA_ABIERTA'), review: count('EN_REVISION'), observed: count('OBSERVADO'), partial: count('CIERRE_PARCIAL'), closed: count('CERRADO'),
      pendingAmount: rows.reduce((a, x) => a + x.s.pendingAgreed, 0), variation, variationPct: withFinal ? Math.round(variation / withFinal * 1000) / 10 : null,
    }
  }, [rows])
  const options = useMemo(() => {
    const uniq = (values: (string | null | undefined)[]) => [...new Set(values.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, 'es'))
    return {
      suppliers: uniq(rows.flatMap(x => x.r.items.map(i => i.supplier))),
      concepts: uniq(rows.flatMap(x => x.r.items.map(i => i.concept))),
      contracts: uniq(rows.flatMap(x => (x.r.contracts || '').split(', '))),
      responsibles: uniq(rows.map(x => x.r.last?.by)),
    }
  }, [rows])

  const filtered = useMemo(() => {
    const q = f.q.trim().toLowerCase(), plate = f.plate.trim().toLowerCase()
    const list = rows.filter(({ r, key }) => (!f.econ || key === f.econ) && (!f.doc || r.doc_status === f.doc)
      && (!f.supplier || r.items.some(i => i.supplier === f.supplier)) && (!f.concept || r.items.some(i => i.concept === f.concept))
      && (!f.contract || (r.contracts || '').split(', ').includes(f.contract)) && (!plate || (r.plate || '').toLowerCase().includes(plate))
      && (!f.responsible || r.last?.by === f.responsible)
      && (!q || [r.dispatch_number, r.contracts, r.requests, r.plate].join(' ').toLowerCase().includes(q)))
    const time = (v: string | null) => (v ? new Date(v).getTime() : 0)
    const by: Record<Sort, (a: typeof list[number], b: typeof list[number]) => number> = {
      fecha: (a, b) => time(b.r.departure) - time(a.r.departure),
      monto: (a, b) => b.s.agreed - a.s.agreed,
      desviacion: (a, b) => Math.abs(b.s.variation) - Math.abs(a.s.variation),
      antiguedad: (a, b) => time(a.r.departure) - time(b.r.departure),
      pendientes: (a, b) => b.s.pending.length - a.s.pending.length || time(a.r.departure) - time(b.r.departure),
    }
    return [...list].sort(by[sort])
  }, [rows, f, sort])
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize)

  const act = async (r: EconRoute, action: 'APROBAR' | 'OBSERVAR') => {
    let reason: string | null = null
    if (action === 'OBSERVAR') { reason = window.prompt('Observación para Programación (qué falta o qué corregir)'); if (reason === null) return }
    const { data, error } = await supabase.rpc('economic_closure_action', { p_dispatch_id: r.dispatch_id, p_action: action, p_reason: reason })
    if (error || !data?.success) { toast.error(error ? errorMessage(error) : data?.error); return }
    toast.success(action === 'APROBAR' ? `Ruta ${r.dispatch_number}: cierre aprobado` : `Ruta ${r.dispatch_number}: observada`)
    void load()
  }
  const rowActions = (r: EconRoute): TableAction[] => {
    const review = ['EN_REVISION', 'CIERRE_PARCIAL'].includes(r.state.status)
    return [
      { id: 'ver', label: 'Ver detalle', icon: <Eye className="h-4 w-4" />, onSelect: () => setOpen({ id: r.dispatch_id, tab: 'resumen' }) },
      { id: 'validar', label: 'Validar costos', icon: <ClipboardCheck className="h-4 w-4" />, onSelect: () => setOpen({ id: r.dispatch_id, tab: 'servicios' }),
        disabled: !perm.validate || ['EN_REVISION', 'CERRADO', 'NO_APLICA'].includes(r.state.status) },
      { id: 'observar', label: 'Observar', icon: <XCircle className="h-4 w-4" />, tone: 'danger', onSelect: () => act(r, 'OBSERVAR'), disabled: !perm.approve || !review },
      { id: 'aprobar', label: 'Aprobar cierre', icon: <CheckCircle2 className="h-4 w-4" />, onSelect: () => act(r, 'APROBAR'), disabled: !perm.approve || !review || r.state.pending.length > 0 },
      { id: 'documentario', label: 'Ir a cierre documentario', icon: <FileText className="h-4 w-4" />, onSelect: () => router.push(documentaryHref(r.dispatch_id)) },
    ]
  }

  return (
    <div className="min-w-0 space-y-3">
      <PageHeader showTitle title="Cierre económico" description="Costo final por servicio: referencial, acordado y final, con validación y aprobación"
        actions={<><button type="button" onClick={() => void load()} className="flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm hover:bg-slate-50"><RefreshCw className="h-4 w-4" />Actualizar</button>
          <Link href="/despacho/documentos" className="flex h-10 items-center rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">Cierre documentario</Link></>} />
      <p className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-[#002855]"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        Independiente del cierre documentario: una ruta puede tener la documentación completa y sus costos pendientes. No se cierra mientras falte validar el flete o algún servicio.</p>

      <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <KpiStatCard label="Pendientes" value={kpis.pending} tone="amber" icon={<Hourglass className="h-5 w-5" />} loading={!routes} active={f.econ === 'PENDIENTE'} onClick={() => setFilter({ econ: f.econ === 'PENDIENTE' ? '' : 'PENDIENTE' })} />
        <KpiStatCard label="En revisión" value={kpis.review} tone="blue" icon={<Clock className="h-5 w-5" />} loading={!routes} active={f.econ === 'EN_REVISION'} onClick={() => setFilter({ econ: f.econ === 'EN_REVISION' ? '' : 'EN_REVISION' })} />
        <KpiStatCard label="Observadas" value={kpis.observed} tone="rose" icon={<XCircle className="h-5 w-5" />} loading={!routes} active={f.econ === 'OBSERVADO'} onClick={() => setFilter({ econ: f.econ === 'OBSERVADO' ? '' : 'OBSERVADO' })} />
        <KpiStatCard label={kpis.partial ? `Cerradas (+${kpis.partial} parciales)` : 'Cerradas'} value={kpis.closed} tone="emerald" icon={<CheckCircle2 className="h-5 w-5" />} loading={!routes} active={f.econ === 'CERRADO'} onClick={() => setFilter({ econ: f.econ === 'CERRADO' ? '' : 'CERRADO' })} />
        <KpiStatCard label="Monto pendiente de validar" value={`S/ ${money(kpis.pendingAmount)}`} tone="violet" icon={<Wallet className="h-5 w-5" />} loading={!routes} />
        <KpiStatCard label={`Variación acumulada${kpis.variationPct != null ? ` (${kpis.variationPct > 0 ? '+' : ''}${kpis.variationPct}%)` : ''}`} value={`${kpis.variation > 0 ? '+' : ''}${money(kpis.variation)}`}
          tone={kpis.variation > 0 ? 'rose' : 'emerald'} icon={<AlertTriangle className="h-5 w-5" />} loading={!routes} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Vista" className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {([['bandeja', 'Bandeja de cierre'], ['indicadores', 'Indicadores']] as const).map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => setView(k)}
            className={`min-h-9 rounded-md px-3 text-sm font-semibold ${view === k ? 'bg-[#002855] text-white' : 'text-slate-600 hover:text-[#002855]'}`}>{label}</button>)}
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-500">Desde<input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
        <label className="flex items-center gap-2 text-xs text-slate-500">Hasta<input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
      </div>

      {view === 'indicadores' ? <ServiceCostIndicators from={from} to={to} /> : <>
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-2">
          <label className="relative min-w-0 flex-1 basis-56"><span className="sr-only">Buscar ruta, OT, solicitud o placa</span><Search aria-hidden className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input value={f.q} onChange={e => setFilter({ q: e.target.value })} placeholder="Ruta, OT, solicitud o placa…" className="h-9 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-[#002855]" /></label>
          <select aria-label="Estado económico" value={f.econ} onChange={e => setFilter({ econ: e.target.value })} className={select}>
            <option value="">Estado eco.: todos</option>{Object.entries(ECON_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
          <select aria-label="Estado documentario" value={f.doc} onChange={e => setFilter({ doc: e.target.value })} className={select}>
            <option value="">Estado doc.: todos</option>{['COMPLETO', 'PENDIENTE', 'OBSERVADO'].map(k => <option key={k} value={k}>{DOC_STATUS[k].label}</option>)}</select>
          <select aria-label="Proveedor" value={f.supplier} onChange={e => setFilter({ supplier: e.target.value })} className={`${select} max-w-48`}>
            <option value="">Proveedor: todos</option>{options.suppliers.map(s => <option key={s} value={s}>{s}</option>)}</select>
          <select aria-label="Tipo de servicio" value={f.concept} onChange={e => setFilter({ concept: e.target.value })} className={select}>
            <option value="">Servicio: todos</option>{options.concepts.map(c => <option key={c} value={c}>{ITEM_LABEL[c] || c}</option>)}</select>
          <select aria-label="OT" value={f.contract} onChange={e => setFilter({ contract: e.target.value })} className={select}>
            <option value="">OT: todas</option>{options.contracts.map(c => <option key={c} value={c}>{c}</option>)}</select>
          <input aria-label="Placa" value={f.plate} onChange={e => setFilter({ plate: e.target.value })} placeholder="Placa" className={`${select} w-24`} />
          <select aria-label="Responsable" value={f.responsible} onChange={e => setFilter({ responsible: e.target.value })} className={`${select} max-w-44`}>
            <option value="">Responsable: todos</option>{options.responsibles.map(s => <option key={s} value={s}>{s}</option>)}</select>
          <select aria-label="Ordenar por" value={sort} onChange={e => { setSort(e.target.value as Sort); setPage(1) }} className={select}>
            {SORTS.map(([k, label]) => <option key={k} value={k}>Orden: {label}</option>)}</select>
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="overflow-x-auto">
            {routes === null ? <p className="p-8 text-center text-sm text-slate-500">Cargando…</p>
              : filtered.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">No hay rutas para los filtros seleccionados.</p>
              : <table className="w-full min-w-[84rem] text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr>
                  <th className="px-3 py-2">Ruta</th><th className="px-3 py-2">OT · solicitudes</th><th className="px-3 py-2">Estado doc.</th><th className="px-3 py-2">Estado eco.</th>
                  <th className="px-3 py-2">Proveedor</th><th className="px-3 py-2 text-right">Referencial</th><th className="px-3 py-2 text-right">Acordado</th><th className="px-3 py-2 text-right">Final</th>
                  <th className="px-3 py-2 text-right">Variación</th><th className="px-3 py-2">Pendientes</th><th className="px-3 py-2">Responsable</th><th className="px-3 py-2"><span className="sr-only">Acciones</span></th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {visible.map(({ r, s, key }) => {
                    const alert = isDeviation(s.agreedWithFinal, s.final, settings)
                    return <tr key={r.dispatch_id} className={`cursor-pointer hover:bg-slate-50 ${alert ? 'bg-red-50/40' : ''}`} onClick={() => setOpen({ id: r.dispatch_id, tab: 'resumen' })}>
                      <td className="px-3 py-2"><b className="text-[#002855] underline">{r.dispatch_number}</b>
                        <span className="block text-xs text-slate-500">{fmtDate(r.departure)} · {r.plate || '—'}</span>
                        <span className="block text-[11px] text-slate-400">{dispatchStatusLabel(r.status)}</span></td>
                      <td className="px-3 py-2 text-xs">{r.contracts || 'Sin OT'}<span className="block text-slate-500">{r.requests}</span></td>
                      <td className="px-3 py-2"><Badge map={DOC_STATUS} value={r.doc_status} /></td>
                      <td className="px-3 py-2"><Badge map={ECON_STATUS} value={key} />{s.approved > 0 && s.approved < s.total && <span className="block text-[11px] text-slate-500">{s.approved} de {s.total} aprobados</span>}</td>
                      <td className="px-3 py-2 text-xs">{s.suppliers[0] || '—'}{s.suppliers.length > 1 && <span className="ml-1 rounded bg-slate-100 px-1 text-[11px] font-semibold text-slate-600" title={s.suppliers.slice(1).join(', ')}>+{s.suppliers.length - 1}</span>}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(s.referential)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(s.agreed)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.final == null ? '—' : money(s.final)}{s.final != null && s.validated < s.total && <span className="block text-[11px] text-slate-500">{s.validated}/{s.total} ítems</span>}</td>
                      <td className="px-3 py-2 text-right text-xs">{s.final == null ? '—' : <Variation base={s.agreedWithFinal} value={s.final} settings={settings} />}</td>
                      <td className="px-3 py-2 text-xs text-slate-600">{pendingText(s.pending) || (key === 'RUTA_ABIERTA' ? 'Cerrar ruta en Torre' : '—')}</td>
                      <td className="px-3 py-2 text-xs">{r.last?.by || '—'}<span className="block text-[11px] text-slate-500">{fmtDateTime(r.last?.at)}</span></td>
                      <td className="px-3 py-2 text-right" onClick={e => e.stopPropagation()}><TableActions label={`Acciones de la ruta ${r.dispatch_number}`} actions={rowActions(r)} /></td>
                    </tr>
                  })}
                </tbody>
              </table>}
          </div>
          <TablePagination total={filtered.length} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={n => { setPageSize(n); setPage(1) }} itemLabel="rutas" compact />
        </div>
        <p className="text-[11px] text-slate-500">Variación en rojo: supera el {settings.deviation_pct}% o S/ {money(Number(settings.deviation_pen))} sobre lo acordado (umbral configurable). Monto pendiente de validar: acordado de los ítems sin costo final.</p>
      </>}

      {open && <EconomicClosurePanel key={open.id} dispatchId={open.id} initialTab={open.tab} onClose={() => setOpen(null)} onChanged={() => void load()} />}
    </div>
  )
}
