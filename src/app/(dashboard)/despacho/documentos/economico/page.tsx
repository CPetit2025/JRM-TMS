"use client"
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, Ban, CheckCircle2, ClipboardCheck, Clock, Eye, FileText, Hourglass, Loader2, RefreshCw, Search, ShieldCheck, ThumbsUp, TowerControl, Wallet, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { TransportWorkflow } from '@/components/transport/TransportWorkflow'
import { ControlPresupuestalTabs } from '@/components/despacho/ControlPresupuestalTabs'
import { KpiStatCard } from '@/components/ui/kpi-stat-card'
import { TablePagination } from '@/components/ui/table-pagination'
import { TableActions, type TableAction } from '@/components/ui/table-actions'
import { errorMessage, money } from '@/lib/caja'
import {
  DEFAULT_SETTINGS, DOC_STATUS, ECON_STATUS, ECON_VIEW, ITEM_LABEL, ROUTE_STATUS, daysPending, documentaryHref, econKey, isDeviation, isLiberated, pendingText, routeSummary, serviceText, supplierText, valuedItems,
  type EconRoute, type EconSettings,
} from '@/lib/economic-closure'
import { EconomicClosurePanel, Variation } from '@/components/despacho/EconomicClosurePanel'
import { ServiceCostIndicators } from '@/components/despacho/ServiceCostIndicators'

// Cierre económico por ruta, separado del cierre documentario: bandeja con indicadores, estado documentario y económico,
// fecha, unidad, cliente, OT y orden de referencia, servicio, estado de la ruta en Torre, proveedor, referencial → acordado →
// final con su variación (en rojo sobre el umbral configurable), pendiente y días en espera; filtros, orden y paginación.
// Cierre simplificado: Por cerrar → «Conforme» (por ruta o en lote) cierra lo acordado; solo lo que supera el umbral queda
// Por aprobar. Empieza al liberar la unidad (no espera Torre). Detalle en un panel lateral.

const supabase = createClient()
const limaDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : '—')
type Sort = 'fecha' | 'monto' | 'desviacion' | 'antiguedad' | 'pendientes'
const SORTS: [Sort, string][] = [['fecha', 'Fecha (recientes)'], ['monto', 'Monto acordado'], ['desviacion', 'Mayor desviación'], ['antiguedad', 'Días en espera'], ['pendientes', 'N.º de pendientes']]
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
  const [f, setF] = useState({ q: '', econ: '', doc: '', supplier: '', concept: '', contract: '', plate: '', responsible: '', client: '', unit: '', route: '' })
  const [sort, setSort] = useState<Sort>('fecha')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulk, setBulk] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('economic_closure_queue', { p_from: from, p_to: to })
    if (error || !data?.success) { toast.error(error ? errorMessage(error) : data?.error); setRoutes([]); return }
    setRoutes(data.routes as EconRoute[])
    setPerm({ validate: !!data.can_validate, approve: !!data.can_approve })
    if (data.settings) setSettings(data.settings as EconSettings)
  }, [from, to])
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [load])
  const setFilter = (patch: Partial<typeof f>) => { setF(prev => ({ ...prev, ...patch })); setPage(1) }

  const rows = useMemo(() => (routes || []).map(r => ({ r, s: routeSummary(r), key: econKey(r), days: daysPending(r.ready_at ?? r.departure) })), [routes])
  const kpis = useMemo(() => {
    const count = (k: string) => rows.filter(x => x.key === k).length
    const withFinal = rows.reduce((a, x) => a + x.s.agreedWithFinal, 0)
    const variation = rows.reduce((a, x) => a + x.s.variation, 0)
    return {
      toClose: count('POR_CERRAR'), toApprove: count('POR_APROBAR'), closed: count('CERRADO'), noCost: count('NO_APLICA'),
      unreleased: rows.filter(x => !isLiberated(x.r.status)).length,
      pendingAmount: rows.reduce((a, x) => a + x.s.pendingAgreed, 0), variation, variationPct: withFinal ? Math.round(variation / withFinal * 1000) / 10 : null,
    }
  }, [rows])
  const options = useMemo(() => {
    const uniq = (values: (string | null | undefined)[]) => [...new Set(values.filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b, 'es'))
    return {
      suppliers: uniq(rows.flatMap(x => valuedItems(x.r.items).map(i => i.supplier))),
      concepts: uniq(rows.flatMap(x => valuedItems(x.r.items).map(i => i.concept))),
      contracts: uniq(rows.flatMap(x => (x.r.contracts || '').split(', '))),
      responsibles: uniq(rows.map(x => x.r.last?.by)),
      clients: uniq(rows.flatMap(x => (x.r.clients || '').split(', '))),
    }
  }, [rows])

  const filtered = useMemo(() => {
    const q = f.q.trim().toLowerCase(), plate = f.plate.trim().toLowerCase()
    const list = rows.filter(({ r, key }) => (!f.econ || key === f.econ) && (!f.doc || r.doc_status === f.doc)
      && (!f.supplier || valuedItems(r.items).some(i => i.supplier === f.supplier)) && (!f.concept || valuedItems(r.items).some(i => i.concept === f.concept))
      && (!f.contract || (r.contracts || '').split(', ').includes(f.contract)) && (!plate || (r.plate || '').toLowerCase().includes(plate))
      && (!f.responsible || r.last?.by === f.responsible) && (!f.client || (r.clients || '').split(', ').includes(f.client))
      && (!f.unit || (f.unit === 'TERCERO') === (r.modalidad === 'TERCERO')) && (!f.route || r.status === f.route)
      && (!q || [r.dispatch_number, r.contracts, r.requests, r.references, r.clients, r.carrier, r.plate].join(' ').toLowerCase().includes(q)))
    const time = (v: string | null) => (v ? new Date(v).getTime() : 0)
    const by: Record<Sort, (a: typeof list[number], b: typeof list[number]) => number> = {
      fecha: (a, b) => time(b.r.departure) - time(a.r.departure),
      monto: (a, b) => b.s.agreed - a.s.agreed,
      desviacion: (a, b) => Math.abs(b.s.variation) - Math.abs(a.s.variation),
      antiguedad: (a, b) => (b.days ?? 0) - (a.days ?? 0) || time(a.r.departure) - time(b.r.departure),
      pendientes: (a, b) => b.s.pending.length - a.s.pending.length || (b.days ?? 0) - (a.days ?? 0),
    }
    return [...list].sort(by[sort])
  }, [rows, f, sort])
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize)
  const canConform = (r: EconRoute, key: string) => perm.validate && key === 'POR_CERRAR' && isLiberated(r.status)
  const eligible = visible.filter(x => canConform(x.r, x.key))
  const picked = filtered.filter(x => selected.has(x.r.dispatch_id) && canConform(x.r, x.key)).map(x => x.r)

  // «Conforme»: registra como final lo acordado de lo que falta y cierra; lo que supera el umbral queda por aprobar
  const conform = async (list: EconRoute[]) => {
    if (!list.length) return
    setBulk(true)
    let closed = 0, review = 0
    const errors: string[] = []
    for (const r of list) {
      const { data, error } = await supabase.rpc('economic_confirm', { p_dispatch_id: r.dispatch_id, p_conforme: true })
      if (error || !data?.success) errors.push(error ? errorMessage(error) : String(data?.error))
      else if ((data.review || []).length) review++
      else closed++
    }
    setBulk(false); setSelected(new Set())
    if (closed) toast.success(`${closed} ruta${closed > 1 ? 's' : ''} cerrada${closed > 1 ? 's' : ''} conforme`)
    if (review) toast.info(`${review} ruta${review > 1 ? 's' : ''} con desviación sobre el umbral: queda${review > 1 ? 'n' : ''} por aprobar`)
    if (errors.length) toast.error(errors.slice(0, 3).join(' · '))
    void load()
  }
  const toggle = (idv: string) => setSelected(prev => { const next = new Set(prev); if (next.has(idv)) next.delete(idv); else next.add(idv); return next })

  const act = async (r: EconRoute, action: 'APROBAR' | 'OBSERVAR') => {
    let reason: string | null = null
    if (action === 'OBSERVAR') { reason = window.prompt('Observación para Programación (qué falta o qué corregir)'); if (reason === null) return }
    const { data, error } = await supabase.rpc('economic_closure_action', { p_dispatch_id: r.dispatch_id, p_action: action, p_reason: reason })
    if (error || !data?.success) { toast.error(error ? errorMessage(error) : data?.error); return }
    toast.success(action === 'APROBAR' ? `Ruta ${r.dispatch_number}: cierre aprobado` : `Ruta ${r.dispatch_number}: observada`)
    void load()
  }
  const rowActions = (r: EconRoute, key: string): TableAction[] => {
    const review = key === 'POR_APROBAR'
    return [
      { id: 'ver', label: 'Ver detalle', icon: <Eye className="h-4 w-4" />, onSelect: () => setOpen({ id: r.dispatch_id, tab: 'resumen' }) },
      { id: 'conforme', label: 'Conforme (cerrar lo acordado)', icon: <ThumbsUp className="h-4 w-4" />, onSelect: () => void conform([r]), disabled: bulk || !canConform(r, key) },
      { id: 'validar', label: 'Registrar costo distinto', icon: <ClipboardCheck className="h-4 w-4" />, onSelect: () => setOpen({ id: r.dispatch_id, tab: 'servicios' }), disabled: !canConform(r, key) },
      { id: 'aprobar', label: 'Aprobar desviación', icon: <CheckCircle2 className="h-4 w-4" />, onSelect: () => act(r, 'APROBAR'), disabled: !perm.approve || !review },
      { id: 'observar', label: 'Observar', icon: <XCircle className="h-4 w-4" />, tone: 'danger', onSelect: () => act(r, 'OBSERVAR'), disabled: !perm.approve || !review },
      { id: 'documentario', label: 'Ir a cierre documentario', icon: <FileText className="h-4 w-4" />, onSelect: () => router.push(documentaryHref(r.dispatch_id)) },
    ]
  }

  return (
    <div className="min-w-0 space-y-3">
      <PageHeader showTitle title="Control presupuestal · Costos por ruta" description="Costo final por servicio: referencial, acordado y final. Lo que supera el umbral se resuelve en Desvíos."
        actions={<><button type="button" onClick={() => void load()} className="flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm hover:bg-slate-50"><RefreshCw className="h-4 w-4" />Actualizar</button>
          <Link href="/despacho/documentos" className="flex h-10 items-center rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">Cierre documentario</Link></>} />
      <TransportWorkflow current="economico" />
      <ControlPresupuestalTabs active="rutas" />
      <p className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-[#002855]"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        Solo se trabaja lo que se sale de lo acordado: «Conforme» cierra la ruta en un paso; dentro del umbral ({settings.deviation_pct}% o {money(Number(settings.deviation_pen))}) se cierra sin motivo ni aprobación; sobre el umbral pasa a «Por aprobar». Empieza al liberar la unidad.</p>

      <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <KpiStatCard label="Por cerrar" value={kpis.toClose} tone="amber" icon={<Hourglass className="h-5 w-5" />} loading={!routes} active={f.econ === 'POR_CERRAR'} onClick={() => setFilter({ econ: f.econ === 'POR_CERRAR' ? '' : 'POR_CERRAR' })} />
        <KpiStatCard label="Por aprobar (sobre el umbral)" value={kpis.toApprove} tone="blue" icon={<Clock className="h-5 w-5" />} loading={!routes} active={f.econ === 'POR_APROBAR'} onClick={() => setFilter({ econ: f.econ === 'POR_APROBAR' ? '' : 'POR_APROBAR' })} />
        <KpiStatCard label="Cerradas" value={kpis.closed} tone="emerald" icon={<CheckCircle2 className="h-5 w-5" />} loading={!routes} active={f.econ === 'CERRADO'} onClick={() => setFilter({ econ: f.econ === 'CERRADO' ? '' : 'CERRADO' })} />
        <KpiStatCard label="No aplica (sin costos)" value={kpis.noCost} tone="slate" icon={<Ban className="h-5 w-5" />} loading={!routes} active={f.econ === 'NO_APLICA'} onClick={() => setFilter({ econ: f.econ === 'NO_APLICA' ? '' : 'NO_APLICA' })} />
        <KpiStatCard label="Monto pendiente de validar" value={`${money(kpis.pendingAmount)}`} tone="violet" icon={<Wallet className="h-5 w-5" />} loading={!routes} />
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
        {kpis.unreleased > 0 && f.route !== 'ENTREGADO' && <div className="flex flex-wrap items-center gap-2 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-sm text-orange-900">
          <TowerControl className="h-4 w-4 shrink-0" /><span className="min-w-0 flex-1">
            <b>{kpis.unreleased} ruta{kpis.unreleased > 1 ? 's' : ''} con la unidad sin liberar</b>: su cierre económico empieza cuando Torre de Control libera la unidad.</span>
          <button type="button" onClick={() => setFilter({ route: 'ENTREGADO' })} className="rounded-lg border border-orange-300 bg-white px-3 py-1 text-xs font-semibold text-orange-900 hover:bg-orange-100">Ver rutas</button>
        </div>}
        {perm.validate && <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={bulk || picked.length === 0} onClick={() => void conform(picked)}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#002855] px-3 text-sm font-semibold text-white disabled:opacity-50">
            {bulk ? <Loader2 className="h-4 w-4 animate-spin" /> : <ThumbsUp className="h-4 w-4" />}Marcar conforme{picked.length ? ` (${picked.length})` : ''}</button>
          <span className="text-xs text-slate-500">Seleccione rutas «Por cerrar»: se cierran con lo acordado; las que superen el umbral quedan por aprobar.</span>
        </div>}
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-2">
          <label className="relative min-w-0 flex-1 basis-56"><span className="sr-only">Buscar ruta, cliente, OT, solicitud, orden o placa</span><Search aria-hidden className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input value={f.q} onChange={e => setFilter({ q: e.target.value })} placeholder="Ruta, cliente, OT, solicitud, OC o placa…" className="h-9 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-[#002855]" /></label>
          <select aria-label="Cliente" value={f.client} onChange={e => setFilter({ client: e.target.value })} className={`${select} max-w-48`}>
            <option value="">Cliente: todos</option>{options.clients.map(c => <option key={c} value={c}>{c}</option>)}</select>
          <select aria-label="Unidad" value={f.unit} onChange={e => setFilter({ unit: e.target.value })} className={select}>
            <option value="">Unidad: todas</option><option value="PROPIA">Flota propia</option><option value="TERCERO">Tercero</option></select>
          <select aria-label="Estado de la ruta" value={f.route} onChange={e => setFilter({ route: e.target.value })} className={select}>
            <option value="">Estado ruta: todos</option><option value="ENTREGADO">Entregada (sin liberar)</option>{Object.entries(ROUTE_STATUS).filter(([k]) => k !== 'ENTREGADO').map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <select aria-label="Estado económico" value={f.econ} onChange={e => setFilter({ econ: e.target.value })} className={select}>
            <option value="">Estado eco.: todos</option>{ECON_VIEW.map(k => <option key={k} value={k}>{ECON_STATUS[k].label}</option>)}</select>
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
              : <table className="w-full min-w-[96rem] text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr>
                  <th className="w-8 px-3 py-2">{perm.validate && <input type="checkbox" aria-label="Seleccionar las rutas por cerrar de esta página" disabled={!eligible.length}
                    checked={eligible.length > 0 && eligible.every(x => selected.has(x.r.dispatch_id))}
                    onChange={e => setSelected(prev => { const next = new Set(prev); for (const x of eligible) { if (e.target.checked) next.add(x.r.dispatch_id); else next.delete(x.r.dispatch_id) } return next })} />}</th>
                  <th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Unidad</th><th className="px-3 py-2">Cliente</th><th className="px-3 py-2">OT · solicitud</th><th className="px-3 py-2">Servicio</th>
                  <th className="px-3 py-2">Estado ruta</th><th className="px-3 py-2">Doc.</th><th className="px-3 py-2">Eco.</th><th className="px-3 py-2">Proveedor</th>
                  <th className="px-3 py-2 text-right">Referencial</th><th className="px-3 py-2 text-right">Acordado</th><th className="px-3 py-2 text-right">Final</th><th className="px-3 py-2 text-right">Var.</th>
                  <th className="px-3 py-2">Pendiente</th><th className="px-3 py-2 text-right">Días</th><th className="px-3 py-2"><span className="sr-only">Acciones</span></th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {visible.map(({ r, s, key, days }) => {
                    const alert = isDeviation(s.agreedWithFinal, s.final, settings)
                    const amount = (v: number) => (s.total ? money(v) : '—')
                    const late = days != null && days > (settings.max_pending_days ?? 7)
                    return <tr key={r.dispatch_id} className={`cursor-pointer hover:bg-slate-50 ${alert ? 'bg-red-50/40' : ''}`} onClick={() => setOpen({ id: r.dispatch_id, tab: 'resumen' })}>
                      <td className="px-3 py-2" onClick={e => e.stopPropagation()}>{canConform(r, key) && <input type="checkbox" aria-label={`Seleccionar la ruta ${r.dispatch_number}`}
                        checked={selected.has(r.dispatch_id)} onChange={() => toggle(r.dispatch_id)} />}</td>
                      <td className="whitespace-nowrap px-3 py-2">{fmtDate(r.departure)}<span className="block text-[11px] text-slate-400">Ruta {r.dispatch_number}</span></td>
                      <td className="whitespace-nowrap px-3 py-2 font-semibold text-[#002855]">{r.plate || '—'}<span className="block text-[11px] font-normal text-slate-500">{r.modalidad === 'TERCERO' ? 'Tercero' : 'Propia'}</span></td>
                      <td className="max-w-48 px-3 py-2 text-xs">{r.clients || '—'}</td>
                      <td className="px-3 py-2 text-xs">{[r.contracts || 'Sin OT', r.references].filter(Boolean).join(' · ')}<span className="block text-slate-500">{r.requests}</span></td>
                      <td className="px-3 py-2 text-xs">{serviceText(r)}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs">{ROUTE_STATUS[r.status] || r.status}</td>
                      <td className="px-3 py-2"><Badge map={DOC_STATUS} value={r.doc_status} /></td>
                      <td className="px-3 py-2"><Badge map={ECON_STATUS} value={key} />{s.approved > 0 && s.approved < s.total && <span className="block text-[11px] text-slate-500">{s.approved} de {s.total} aprobados</span>}</td>
                      <td className="px-3 py-2 text-xs">{supplierText(r, s.suppliers)}{s.suppliers.length > 1 && <span className="ml-1 rounded bg-slate-100 px-1 text-[11px] font-semibold text-slate-600" title={s.suppliers.slice(1).join(', ')}>+{s.suppliers.length - 1}</span>}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{amount(s.referential)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{amount(s.agreed)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.final == null ? '—' : money(s.final)}{s.final != null && s.validated < s.total && <span className="block text-[11px] text-slate-500">{s.validated}/{s.total} ítems</span>}</td>
                      <td className="px-3 py-2 text-right text-xs">{s.final == null ? '—' : <Variation base={s.agreedWithFinal} value={s.final} settings={settings} />}</td>
                      <td className="px-3 py-2 text-xs text-slate-600">{!isLiberated(r.status) ? <span className="font-semibold text-orange-800">Liberar unidad en Torre</span>
                        : key === 'POR_APROBAR' ? <span className="font-semibold text-blue-800">Aprobar desviación</span>
                        : key === 'POR_CERRAR' ? (pendingText(s.pending) || 'Confirmar conforme') : '—'}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${late ? 'font-semibold text-red-700' : ''}`} title={`Días desde que la ruta quedó lista para el cierre (atrasada desde ${settings.max_pending_days ?? 7})`}>{days ?? '—'}</td>
                      <td className="px-3 py-2 text-right" onClick={e => e.stopPropagation()}><TableActions label={`Acciones de la ruta ${r.dispatch_number}`} actions={rowActions(r, key)} /></td>
                    </tr>
                  })}
                </tbody>
              </table>}
          </div>
          <TablePagination total={filtered.length} page={page} pageSize={pageSize} onPageChange={setPage} onPageSizeChange={n => { setPageSize(n); setPage(1) }} itemLabel="rutas" compact />
        </div>
        <p className="text-[11px] text-slate-500">Variación en rojo: supera el {settings.deviation_pct}% o {money(Number(settings.deviation_pen))} sobre lo acordado (umbral configurable). Monto pendiente de validar: acordado de los ítems sin costo final. Días: desde el cierre operativo o el retorno de la unidad (en rojo, más de 7). Por cerrar incluye lo observado y lo cerrado en parte.</p>
      </>}

      {open && <EconomicClosurePanel key={open.id} dispatchId={open.id} initialTab={open.tab} onClose={() => setOpen(null)} onChanged={() => void load()} />}
    </div>
  )
}
