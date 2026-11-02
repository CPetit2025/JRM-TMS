'use client'

import { Fragment, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, ArrowDownUp, BarChart3, Box, CalendarDays, ChevronDown, ChevronRight, ClipboardCheck, ClipboardX, Clock, Coins, Download, ExternalLink, Gauge, LayoutGrid, List, Loader2, Navigation,
  Route, Scale, Search, Truck, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { exportAptXlsx } from '@/lib/apt/export'
import { receiptUrl } from '@/lib/caja'
import { formatKm } from '@/lib/odometer'
import { ALERTS, KM_SOURCE, STATUS, TYPE, applyFilters, bestKm, filtersFrom, fmtDate, fmtTime, fromUnitReport, iso, jornadaKey, references, rowAlerts, shortDate, soles,
  sourceText, summarize, tn, type Fleet, type JornadaRow, type JornadaStatus, type Period, type Ref, type View } from '@/lib/jornada'
import { JornadaExpand, StatusBadge } from '@/components/flota/jornada/JornadaPanels'

// Control de Jornada de Transporte (Vista 1, docs/control-jornada-plan.md): jornadas de toda la flota por unidad y día
// (fleet_workdays), con filtros combinables guardados en la dirección, indicadores que siguen a los filtros, tabla
// agrupada, desplegable con los paneles del detalle, vistas por semana y mes, OT/OS/OC/RQ y exportación.

const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 864e5
const n = (v: number | null | undefined) => v == null ? '—' : Number(v).toLocaleString('es-PE', { maximumFractionDigits: 1 })
// Ícono de cada alerta de la columna Estado (rowAlerts); con más de una se muestra el contador
const ALERT_ICON: Record<string, [LucideIcon, string]> = {
  SIN_CHECKLIST: [ClipboardX, 'text-red-600'], CHECKLIST_OBS: [ClipboardX, 'text-red-600'], SIN_ODOMETRO: [Gauge, 'text-amber-600'], FIN_INFERIDO: [Gauge, 'text-amber-600'],
  ODOMETRO_RETROCEDE: [Gauge, 'text-red-600'], ODOMETRO_SALTO: [Gauge, 'text-red-600'], GPS_INCOMPLETO: [Navigation, 'text-amber-600'], KM_SIN_RUTA: [Route, 'text-orange-600'],
  SIN_CIERRE: [Clock, 'text-blue-600'], INCIDENCIAS: [AlertTriangle, 'text-red-600'],
}

export default function ControlJornadaPage() {
  return <Suspense fallback={null}><ControlJornada /></Suspense>
}

function ControlJornada() {
  const supabase = useMemo(() => createClient(), [])
  const params = useSearchParams(); const router = useRouter(); const path = usePathname()
  const today = iso(new Date())
  const from = params.get('desde') || `${today.slice(0, 7)}-01`, to = params.get('hasta') || today
  const f = filtersFrom(params)
  const [fleet, setFleet] = useState<Fleet | null>(null)
  const [plates, setPlates] = useState<{ plate: string; type: string | null }[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [view, setView] = useState<View>('DIA')
  const [refKind, setRefKind] = useState<'TODAS' | Ref['kind']>('TODAS')
  const [search, setSearch] = useState(params.get('q') || '')
  const [rangeOpen, setRangeOpen] = useState(false)
  const long = days(from, to) > 92

  // Filtros, período y orden en la dirección: el detalle (anterior / siguiente) y el regreso los respetan
  const set = useCallback((changes: Record<string, string>) => {
    const next = new URLSearchParams(params.toString()); next.delete('plate')
    for (const [k, v] of Object.entries(changes)) { if (v) next.set(k, v); else next.delete(k) }
    router.replace(`${path}?${next.toString()}`, { scroll: false })
  }, [params, path, router])

  useEffect(() => { void supabase.rpc('unit_report_plates').then(({ data }) => setPlates((data || []) as { plate: string; type: string | null }[])) }, [supabase])
  useEffect(() => { const load = async () => {
    if (from > to) return
    setLoading(true)
    // Hasta 3 meses, toda la flota; más largo, solo con una unidad (reporte por unidad, sin estado ni ahorro)
    if (!long) {
      const { data, error } = await supabase.rpc('fleet_workdays', { p_from: from, p_to: to })
      setLoading(false)
      if (error || !data?.success) { toast.error(data?.error || error?.message || 'No se pudo cargar el control de jornadas'); setFleet(null); return }
      setFleet(data as Fleet)
    } else if (f.unidad) {
      const { data, error } = await supabase.rpc('unit_daily_report', { p_plate: f.unidad, p_from: from, p_to: to })
      setLoading(false)
      if (error || !data?.success) { toast.error(data?.error || error?.message || 'No se pudo cargar el reporte'); setFleet(null); return }
      setFleet({ success: true, savings_available: false, units: [{ plate: data.plate, type: data.type, status: data.status, current_odometer: data.current_odometer, maintenance: [] }],
        rows: fromUnitReport(data.plate, data.type, data.days) })
    } else { setLoading(false); setFleet(null) }
    setOpen({})
  }
    const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t)
  }, [supabase, from, to, long, f.unidad])
  useEffect(() => { const t = window.setTimeout(() => { if (search.toLowerCase() !== f.q) set({ q: search }) }, 400); return () => window.clearTimeout(t) }, [search, f.q, set])

  const rows = useMemo(() => fleet ? applyFilters([...fleet.rows], f) : [], [fleet, f])
  const drivers = useMemo(() => [...new Set((fleet?.rows || []).flatMap(r => r.drivers || []))].sort(), [fleet])
  const periods = useMemo(() => view !== 'DIA' ? summarize(rows, view) : [], [rows, view])
  const refs = useMemo(() => references(rows), [rows])
  const sum = (get: (r: JornadaRow) => number | null | undefined) => rows.reduce((s, r) => s + Number(get(r) || 0), 0)
  const pendingSavings = sum(r => r.saving?.pending)
  const qs = params.toString()
  const detailHref = (r: JornadaRow) => `/flota/reporte-unidad/${encodeURIComponent(r.plate)}/${r.date}${qs ? `?${qs}` : ''}`

  const preset = (kind: 'SEMANA' | 'MES' | 'MES_ANTERIOR' | 'ANIO') => {
    let a = today, b = today
    if (kind === 'SEMANA') a = addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7))
    else if (kind === 'MES') a = `${today.slice(0, 7)}-01`
    else if (kind === 'MES_ANTERIOR') { b = addDays(`${today.slice(0, 7)}-01`, -1); a = `${b.slice(0, 7)}-01` }
    else { const m = new Date(`${today.slice(0, 7)}-01T12:00:00Z`); m.setUTCMonth(m.getUTCMonth() - 11); a = m.toISOString().slice(0, 10) }
    setView(kind === 'ANIO' ? 'MES' : 'DIA'); set({ desde: a, hasta: b })
  }
  const sortBy = (key: string) => set({ orden: f.orden === `${key}:desc` ? `${key}:asc` : `${key}:desc` })
  const openPhoto = async (p: string) => {
    const url = await receiptUrl(supabase, p)
    if (url) window.open(url, '_blank', 'noopener'); else toast.error('No tiene acceso a la foto')
  }

  const periodRow = (p: Period) => ({ Periodo: p.label, Desde: p.from, Hasta: p.to, 'Jornadas con operación': p.days, 'Km recorridos': Math.round(p.km * 10) / 10,
    'Fuente km': sourceText(p), 'Jornadas sin km': p.daysNoKm, Rutas: p.routes, Servicios: p.services, Toneladas: Math.round(p.tn * 100) / 100,
    OT: [...p.ot].join(', '), OS: [...p.os].join(', '), OC: [...p.oc].join(', '), RQ: [...p.rq].join(', ') })
  const exportXlsx = () => {
    if (!rows.length) return
    exportAptXlsx(`Control_jornada_${f.unidad || 'flota'}_${from}_${to}`, {
      Jornadas: rows.map(d => ({
        Fecha: d.date, Placa: d.plate, Conductores: (d.drivers || []).join(', '), Estado: d.status ? STATUS[d.status].label : '', OT: d.refs.OT.join(', '), OC: d.refs.OC.join(', '), OS: d.refs.OS.join(', '), RQ: d.refs.RQ.join(', '),
        Checklists: d.checklists, Operativa: d.operative == null ? '' : d.operative ? 'Sí' : 'No',
        'Odómetro inicio': d.odo_start, 'Odómetro fin': d.odo_end, 'Fuente fin': d.end_source === 'SIGUIENTE_INICIO' ? 'Inicio del día siguiente (inferido)' : d.end_source === 'CIERRE' ? 'Cierre de jornada' : '',
        'Km odómetro': d.km_odo, 'Km GPS': d.km_gps, 'Km real rutas': d.km_real, 'Km estimado rutas': d.km_est, 'Km por ruta': bestKm(d)?.km ?? null, 'Fuente km ruta': bestKm(d) ? KM_SOURCE[bestKm(d)!.source] : '',
        Rutas: d.routes, Servicios: d.services, 'N° OT': d.ots, Clientes: d.clients, 'Ton transportada': d.tn, 'Toneladas APT': d.tn_apt,
        'Valor independiente referencial (S/)': d.saving?.valued ? d.saving.value : null, 'Costo marginal real (S/)': d.saving?.valued ? d.saving.marginal : null,
        'Ahorro (S/)': d.saving?.valued ? d.saving.saving : null, 'Servicios sin valorizar': d.saving?.pending || null,
        'Costo rutas (S/)': d.cost_total, 'Costo aplicado (S/)': d.cost_applied, 'Costo pendiente (S/)': d.cost_pending,
        Incidencias: d.incidents.length || null, Alertas: d.alerts.map(a => ALERTS[a]?.label || a).join(', '),
      })),
      'Km por semana': summarize(rows, 'SEMANA').map(periodRow),
      'Km por mes': summarize(rows, 'MES').map(periodRow),
      'OT, OS, OC y RQ': refs.map(r => ({ Tipo: r.kind, Número: r.number, Cliente: [...r.clients].join(', '), 'OT relacionada': [...r.ots].join(', '),
        Servicios: r.services, Rutas: r.routes.size, 'Km medidos': Math.round(r.km * 1000) / 1000, 'Costos asignados S/': Math.round(r.cost * 100) / 100, 'Primera fecha': r.first, 'Última fecha': r.last, 'Peso kg': r.kg || null })),
      Servicios: rows.flatMap(d => d.dispatches.flatMap(x => x.stops.map(s => ({
        Fecha: d.date, Placa: d.plate, Ruta: x.dispatch_number, Estado_ruta: x.status, Conductor: x.driver, 'Km GPS ruta': x.km_gps, 'Km real ruta': x.km_real, 'Fuente km real': x.km_real_source, Parada: s.sequence, Solicitud: s.request_number,
        Tipo: TYPE[s.type] || s.type, OT: s.ot, 'Tipo ref.': s.ref_type, 'N° ref.': s.ref_number, Proveedor_referencia: s.reference_supplier, Cliente: s.client, Origen: s.origin, Destino: s.destination, 'Km tramo': s.km_leg, Odometro_parada: s.odo_reading, Alerta_odometro: s.odo_flag, Guía: s.guide, 'Peso kg': s.kg,
        'Fuente peso': s.kg_source === 'APT' ? 'APT validado' : s.kg_source === 'DECLARADO' ? 'Declarado en solicitud' : '', Fuente_km_tramo: s.km_source || 'Sin dato', Estado: s.status,
      })))),
      'Costos por ruta y OT': rows.flatMap(d => d.dispatches.flatMap(x => (x.costs || []).map(c => ({
        Fecha: d.date, Ruta: x.dispatch_number, Estado_ruta: x.status, Placa: d.plate, Conductor: x.driver,
        OT: c.ot, Solicitud: c.request_number, Tipo: c.expense_type || c.kind, Importe_S: c.amount_pen,
        Estado: c.status, Base_imputacion: c.basis, Galones_asignados: c.fuel_gallons, Odometro_abastecimiento: c.fuel_odometer, Estimado: c.estimated ? 'Sí' : 'No',
      })))),
      Incidencias: rows.flatMap(d => d.incidents.map(i => ({ Fecha: d.date, Placa: d.plate, Origen: i.source, Tipo: i.type, Ruta: i.dispatch_number, Hora: fmtTime(i.at), Detalle: i.detail }))),
      'Lecturas odómetro': rows.flatMap(d => d.readings.map(r => ({ Fecha: d.date, Placa: d.plate, Tipo: r.kind === 'INICIO' ? 'Inicio (checklist)' : 'Cierre de jornada', Hora: fmtTime(r.at), Odómetro: r.odometer, Observación: r.flag || '' }))),
    })
  }

  const totalSaving = sum(r => r.saving?.valued ? r.saving.saving : 0)
  const kpis: Array<{ label: string; value: string; icon: React.ReactNode; tone: string; card?: string; valueTone?: string; hint?: string }> = [
    { label: 'Rutas', value: String(sum(r => r.routes)), icon: <Route className="h-6 w-6" />, tone: 'bg-blue-100 text-blue-700' },
    { label: 'Km odómetro', value: formatKm(Math.round(sum(r => r.km_odo) * 10) / 10), icon: <Gauge className="h-6 w-6" />, tone: 'bg-sky-100 text-[#0b2a4a]',
      hint: rows.some(r => r.end_source === 'SIGUIENTE_INICIO') ? `${rows.filter(r => r.end_source === 'SIGUIENTE_INICIO').length} jornada(s) con fin inferido` : undefined },
    { label: 'Km GPS', value: formatKm(Math.round(sum(r => r.km_gps) * 10) / 10), icon: <Navigation className="h-6 w-6" />, tone: 'bg-blue-100 text-blue-700' },
    { label: 'Carga transportada', value: tn(sum(r => r.tn)), icon: <Box className="h-6 w-6" />, tone: 'bg-emerald-100 text-emerald-700', card: 'bg-emerald-50/40' },
    { label: 'Carga APT', value: tn(sum(r => r.tn_apt)), icon: <Scale className="h-6 w-6" />, tone: 'bg-violet-100 text-violet-700', card: 'bg-violet-50/60' },
    { label: 'Ahorro acumulado', value: fleet?.savings_available ? `S/ ${soles(totalSaving)}` : '—', icon: <Coins className="h-6 w-6" />, tone: 'bg-amber-100 text-amber-600', valueTone: 'text-emerald-700',
      hint: !fleet?.savings_available ? 'Requiere acceso al control presupuestal' : pendingSavings ? `${pendingSavings} servicio(s) sin valorizar` : undefined },
  ]
  const STATES: JornadaStatus[] = ['ABIERTA', 'EN_REVISION', 'CERRADA', 'SIN_OPERACION']
  const shortLong = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
  const sortIcon = (k: string) => <ArrowDownUp className={`ml-1 inline h-3.5 w-3.5 ${f.orden.startsWith(`${k}:`) ? 'opacity-100' : 'opacity-40'}`} aria-hidden />
  const sortBtn = (label: string, k: string) => <button type="button" onClick={() => sortBy(k)} className="font-bold">{label}{sortIcon(k)}</button>
  const ariaSort = (...ks: string[]) => { const hit = ks.find(k => f.orden.startsWith(`${k}:`)); return hit ? f.orden.endsWith(':asc') ? 'ascending' as const : 'descending' as const : undefined }
  // Anchos por contenido: las columnas angostas se ajustan a su dato (w-px) y Conductor / Unidad toma el resto
  const head = (label: React.ReactNode, cls = 'w-px', ...ks: string[]) => <th scope="col" aria-sort={ariaSort(...ks)}
    className={`sticky top-0 z-20 bg-slate-50 px-2 py-2 text-[10px] font-semibold uppercase tracking-wide text-slate-600 ${cls}`}>{label}</th>
  const numCell = 'w-px whitespace-nowrap px-2 text-right tabular-nums'
  const sel = 'h-9 rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-800 outline-none focus:border-[#002855] focus:ring-1 focus:ring-[#002855]'

  return <div className="min-w-0 space-y-3">
    <PageHeader showTitle title="Control de Jornada de Transporte" description="Seguimiento de unidades, recorridos, carga y costos"
      actions={<>
        <div className="relative">
          <button type="button" onClick={() => setRangeOpen(o => !o)} aria-expanded={rangeOpen} className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50">
            <CalendarDays className="h-4 w-4 text-[#002855]" />{shortLong(from)} – {shortLong(to)}<ChevronDown className="h-3.5 w-3.5 text-slate-500" /></button>
          {rangeOpen && <div className="absolute right-0 z-30 mt-2 w-80 space-y-3 rounded-lg border border-slate-200 bg-white p-3 text-slate-900 shadow-lg">
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs font-semibold text-slate-600">Desde<input type="date" value={from} max={to} onChange={e => set({ desde: e.target.value })} className={`${sel} mt-1 w-full`} /></label>
              <label className="text-xs font-semibold text-slate-600">Hasta<input type="date" value={to} min={from} onChange={e => set({ hasta: e.target.value })} className={`${sel} mt-1 w-full`} /></label></div>
            <div className="flex flex-wrap gap-1.5">{([['SEMANA', 'Esta semana'], ['MES', 'Este mes'], ['MES_ANTERIOR', 'Mes anterior'], ['ANIO', 'Últimos 12 meses (una unidad)']] as const).map(([k, label]) =>
              <button key={k} type="button" onClick={() => { preset(k); setRangeOpen(false) }} className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold hover:bg-slate-50">{label}</button>)}</div>
            <p className="text-[11px] text-slate-500">Toda la flota: hasta 3 meses. Con una unidad: hasta 13 meses.</p></div>}
        </div>
        <Link href="/flota/reporte-mensual" className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50"><BarChart3 className="h-4 w-4" />Reporte mensual</Link>
        <button type="button" disabled={!rows.length} onClick={exportXlsx} className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"><Download className="h-4 w-4" />Exportar</button>
      </>} />

    <section aria-label="Indicadores de jornada" className="grid grid-cols-2 divide-x divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white sm:grid-cols-3 sm:divide-y-0 xl:grid-cols-6">
      {kpis.map(k => <div key={k.label} className="min-w-0 px-2.5 py-2">
        <span className="block truncate text-[11px] font-medium text-slate-500">{k.label}</span>
        <span className={`block truncate text-lg font-semibold tabular-nums ${k.valueTone || 'text-slate-900'}`}>{loading ? '…' : k.value}</span>
        {k.hint && <span className="block truncate text-[10px] text-slate-500" title={k.hint}>{k.hint}</span>}
      </div>)}
    </section>

    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white p-2.5">
      <label className="text-xs font-semibold text-slate-600">Conductor<select value={f.conductor} onChange={e => set({ conductor: e.target.value })} className={`${sel} mt-1 block w-48`}>
        <option value="">Todos</option>{drivers.map(d => <option key={d} value={d}>{d}</option>)}</select></label>
      <label className="text-xs font-semibold text-slate-600">Unidad<select value={f.unidad} onChange={e => set({ unidad: e.target.value })} className={`${sel} mt-1 block w-40`}>
        <option value="">Todas</option>{plates.map(p => <option key={p.plate} value={p.plate}>{p.plate}{p.type ? ` · ${p.type}` : ''}</option>)}</select></label>
      <label className="text-xs font-semibold text-slate-600">Estado<select value={f.estado} onChange={e => set({ estado: e.target.value })} className={`${sel} mt-1 block w-44`}>
        <option value="">Todos</option>{STATES.map(s => <option key={s} value={s}>{STATUS[s].label}</option>)}</select></label>
      <label className="relative block w-80 max-w-full"><span className="sr-only">Buscar</span><Search aria-hidden className="absolute left-3 top-[1.35rem] h-4 w-4 text-slate-400" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por OT, OC, OS, RQ, conductor o placa…" className={`${sel} mt-1 w-full pl-9`} /></label>
      <div className="ml-auto flex items-center gap-2">
        <label className="text-xs font-semibold text-slate-600">Agrupar<select value={view} onChange={e => setView(e.target.value as View)} className={`${sel} mt-1 block`}>
          <option value="DIA">Por día</option><option value="SEMANA">Por semana</option><option value="MES">Por mes</option></select></label>
        <div className="inline-flex self-end overflow-hidden rounded-md border border-slate-300 bg-white">
          <button type="button" onClick={() => setView('DIA')} aria-pressed={view === 'DIA'} className={`inline-flex h-9 items-center gap-1.5 px-3 text-sm font-medium ${view === 'DIA' ? 'bg-[#002855] text-white' : 'text-slate-700 hover:bg-slate-50'}`}><LayoutGrid className="h-4 w-4" />Tabla</button>
          <button type="button" disabled={!rows.length} onClick={() => rows[0] && router.push(detailHref(rows[0]))} className="inline-flex h-9 items-center gap-1.5 border-l border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"><List className="h-4 w-4" />Detalle</button></div>
      </div>
    </div>

    {long && !f.unidad ? <p className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-center text-sm text-slate-600">Para toda la flota el período es de hasta 3 meses. Elija una unidad para ver un período mayor.</p>
      : loading && !fleet ? <p className="flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white p-8 text-sm text-slate-600"><Loader2 className="h-4 w-4 animate-spin" />Cargando jornadas…</p>
      : !fleet ? null
      : view !== 'DIA' ? <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-600"><tr>
            <th className="px-2.5 py-2">{view === 'MES' ? 'Mes' : 'Semana'}</th><th className="px-2.5 py-2 text-right">Km recorridos</th><th className="px-2.5 py-2">Fuente</th>
            <th className="px-2.5 py-2 text-right">Jornadas</th><th className="px-2.5 py-2 text-right">Rutas</th><th className="px-2.5 py-2 text-right">Servicios</th><th className="px-2.5 py-2 text-right">Peso</th>
            <th className="px-2.5 py-2">OT</th><th className="px-2.5 py-2">OS</th><th className="px-2.5 py-2">OC</th><th className="px-2.5 py-2">RQ</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{periods.map(p => <tr key={p.key} className={p.days ? 'align-top hover:bg-slate-50' : 'align-top text-slate-400'}>
            <td className="whitespace-nowrap px-2.5 py-2 font-semibold text-[#002855]">{p.label}</td><td className="px-2.5 py-2 text-right font-semibold tabular-nums">{p.km ? formatKm(Math.round(p.km * 10) / 10) : '—'}</td>
            <td className="px-2.5 py-2 text-xs text-slate-600">{sourceText(p) || '—'}{p.daysNoKm > 0 && <span className="block text-amber-700">{p.daysNoKm} jornada(s) operando sin km</span>}</td>
            <td className="px-2.5 py-2 text-right tabular-nums">{p.days || '—'}</td><td className="px-2.5 py-2 text-right tabular-nums">{p.routes || '—'}</td><td className="px-2.5 py-2 text-right tabular-nums">{p.services || '—'}</td>
            <td className="whitespace-nowrap px-2.5 py-2 text-right tabular-nums">{p.tn ? tn(p.tn) : '—'}</td>
            {[p.ot, p.os, p.oc, p.rq].map((s, i) => <td key={i} className="max-w-56 px-2.5 py-2 text-xs">{s.size ? [...s].join(', ') : '—'}</td>)}</tr>)}</tbody>
        </table></div>
      : <div className="max-h-[72vh] overflow-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full border-collapse text-sm">
          <thead><tr>
            {head(<span className="sr-only">Desplegar</span>, 'w-px pl-2 pr-1')}
            {head(sortBtn('Fecha', 'fecha'), 'w-px text-left', 'fecha')}
            {head(sortBtn('Conductor / Unidad', 'conductor'), 'min-w-[11rem] text-left', 'conductor')}
            {head('Referencias', 'w-px text-left')}
            {head(sortBtn('Km recorridos', 'km'), 'w-px text-right', 'km')}
            {head(sortBtn('Km GPS', 'gps'), 'hidden w-px text-right min-[1400px]:table-cell', 'gps')}
            {head(sortBtn('Rutas', 'rutas'), 'w-px text-right', 'rutas')}
            {head(sortBtn('Carga (t)', 'carga'), 'w-px text-right', 'carga')}
            {head(sortBtn('APT (t)', 'apt'), 'hidden w-px text-right min-[1400px]:table-cell', 'apt')}
            {head(<span className="inline-flex gap-1.5">{sortBtn('Costo', 'costo')}{sortBtn('Ahorro', 'ahorro')}</span>, 'w-px text-right', 'costo', 'ahorro')}
            {head(sortBtn('Estado', 'estado'), 'w-px text-left', 'estado')}</tr></thead>
          <tbody>
            {!rows.length && <tr><td colSpan={11} className="p-10 text-center text-slate-500">No hay jornadas para los filtros seleccionados.</td></tr>}
            {rows.map((d, i) => {
              const k = jornadaKey(d), isOpen = open[k], idle = d.status === 'SIN_OPERACION', s = d.saving, alerts = rowAlerts(d), drivers = d.drivers || []
              const refList = (['OT', 'OC', 'OS', 'RQ'] as const).flatMap(t => d.refs[t].map(x => `${t} ${x}`))
              const toggle = () => setOpen(o => ({ ...o, [k]: !o[k] }))
              const costTip = !fleet.savings_available ? 'El ahorro requiere acceso al control presupuestal'
                : [`Valor referencial: ${s?.valued ? `S/ ${soles(s.value)}` : '—'}`, `Costo real (marginal): ${s?.valued ? `S/ ${soles(s.marginal)}` : '—'}`, `Ahorro: ${s?.valued ? `S/ ${soles(s.saving)}` : '—'}`,
                  s?.pending ? `${s.pending} servicio(s) sin valorizar` : '', `Costo de rutas: S/ ${soles(d.cost_total)}`].filter(Boolean).join('\n')
              const [AlertIcon, alertTone] = alerts.length === 1 ? ALERT_ICON[alerts[0].key] || [AlertTriangle, 'text-amber-600'] : [AlertTriangle, 'text-amber-700']
              return <Fragment key={k}>
                <tr className={`border-b border-slate-100 ${isOpen ? 'bg-blue-50' : i % 2 ? 'bg-slate-50/70' : 'bg-white'} ${idle ? 'text-slate-500' : 'text-slate-800'} hover:bg-blue-50/60`}>
                  <td className="w-px py-1.5 pl-2 pr-1"><button type="button" aria-expanded={!!isOpen} aria-label={isOpen ? 'Ocultar detalle' : 'Ver detalle'} onClick={toggle}
                    className="grid h-7 w-7 place-items-center rounded-md text-[#0b2a4a] hover:bg-slate-200/70">{isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button></td>
                  <td className="w-px whitespace-nowrap px-2 py-1.5 font-semibold text-slate-900">{fmtDate(d.date)}</td>
                  <td className="w-full max-w-0 px-2 py-1.5"><div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate font-semibold uppercase" title={drivers.join(', ') || undefined}>{drivers[0] || (idle ? 'Sin operación' : '—')}</span>
                    {drivers.length > 1 && <span className="shrink-0 text-xs font-semibold text-slate-500" title={drivers.join(', ')}>+{drivers.length - 1}</span>}
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-xs font-bold text-slate-700 ring-1 ring-slate-200" title={d.unit_type ? `${d.plate} · ${d.unit_type}` : d.plate}>
                      <Truck className="h-3.5 w-3.5 text-slate-500" aria-hidden />{d.plate}</span>
                    {d.checklists > 0 && <span role="img" className="shrink-0" title={`Checklist (${d.checklists}): ${d.operative === false ? 'con observaciones' : 'operativa'}`} aria-label={`Checklist ${d.operative === false ? 'con observaciones' : 'operativa'}`}>
                      {d.operative === false ? <ClipboardX className="h-4 w-4 text-red-600" /> : <ClipboardCheck className="h-4 w-4 text-emerald-600" />}</span>}</div></td>
                  <td className="w-px px-2 py-1.5"><span className="block max-w-[8rem] truncate text-xs font-semibold text-slate-700" title={refList.join(', ') || undefined}>{refList.join(' · ') || '—'}</span></td>
                  <td className={`${numCell} py-1.5 font-bold text-slate-900`}>{n(d.km_odo)}</td>
                  <td className={`${numCell} hidden min-[1400px]:table-cell`}>{n(d.km_gps)}</td>
                  <td className={numCell}>{d.routes || '—'}</td>
                  <td className={numCell}>{d.tn ? n(d.tn) : '—'}</td>
                  <td className={`${numCell} hidden min-[1400px]:table-cell`}>{d.tn_apt ? n(d.tn_apt) : '—'}</td>
                  <td className={numCell} title={costTip}>{s?.valued ? <><span>S/ {soles(s.marginal)}</span>
                    <span className={`ml-1.5 text-xs font-bold ${s.saving < 0 ? 'text-red-700' : 'text-emerald-700'}`}>{s.saving < 0 ? '−' : '+'}{soles(Math.abs(s.saving))}</span>
                    {s.pending ? <span className="ml-1 text-amber-600" aria-label={`${s.pending} servicio(s) sin valorizar`}>•</span> : null}</>
                    : s?.pending ? <span className="text-xs font-semibold text-amber-700">Pendiente</span> : '—'}</td>
                  <td className="w-px whitespace-nowrap px-2"><div className="flex items-center gap-1.5">
                    <span className="inline-flex w-[5.75rem]"><StatusBadge status={d.status} compact /></span>
                    <span className="inline-flex w-9 justify-center">{alerts.length > 0 && <button type="button" onClick={toggle} title={alerts.map(a => a.label).join('\n')}
                      aria-label={`${alerts.length === 1 ? 'Alerta' : `${alerts.length} alertas`}: ${alerts.map(a => a.label).join(', ')}. Ver detalle`}
                      className={alerts.length === 1 ? `grid h-7 w-7 place-items-center rounded-md hover:bg-slate-200/70 ${alertTone}` : 'inline-flex h-6 items-center gap-0.5 rounded-md bg-amber-50 px-1.5 text-xs font-bold text-amber-800 ring-1 ring-amber-200 hover:bg-amber-100'}>
                      <AlertIcon className={alerts.length === 1 ? 'h-4 w-4' : 'h-3.5 w-3.5'} aria-hidden />{alerts.length > 1 && alerts.length}</button>}</span>
                    {d.status && !idle ? <Link href={detailHref(d)} aria-label="Abrir detalle de la jornada" title="Abrir detalle" className="text-[#0b2a4a]"><ExternalLink className="h-4 w-4" /></Link> : <span className="w-4" />}</div></td>
                </tr>
                {isOpen && <tr className="border-b border-slate-200 bg-blue-50/40"><td colSpan={11} className="px-5 py-4"><JornadaExpand r={d} savingsAvailable={!!fleet.savings_available} openPhoto={openPhoto} /></td></tr>}
              </Fragment>
            })}
          </tbody>
        </table></div>}

    {fleet && <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-2">
        <h2 className="text-sm font-semibold text-slate-800">OT, OS, OC y RQ atendidas</h2>
        <div className="flex flex-wrap gap-1">{(['TODAS', 'OT', 'OS', 'OC', 'RQ'] as const).map(k => <button key={k} type="button" onClick={() => setRefKind(k)} aria-pressed={refKind === k}
          className={`rounded-md px-2.5 py-1 text-xs font-semibold ${refKind === k ? 'bg-[#002855] text-white' : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}>{k === 'TODAS' ? `Todas (${refs.length})` : `${k} (${refs.filter(r => r.kind === k).length})`}</button>)}</div>
      </div>
      {refs.filter(r => refKind === 'TODAS' || r.kind === refKind).length === 0 ? <p className="p-4 text-sm text-slate-500">Sin {refKind === 'TODAS' ? 'OT ni referencias' : refKind} en el período.</p> :
        <div className="overflow-x-auto"><table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-600"><tr><th className="px-2.5 py-2">Tipo</th><th className="px-2.5 py-2">Número</th><th className="px-2.5 py-2">Cliente</th>
            <th className="px-2.5 py-2">OT</th><th className="px-2.5 py-2 text-right">Servicios</th><th className="px-2.5 py-2 text-right">Rutas</th><th className="px-2.5 py-2 text-right">Km medidos</th><th className="px-2.5 py-2 text-right">Costos S/</th><th className="px-2.5 py-2">Fechas</th><th className="px-2.5 py-2 text-right">Peso</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{refs.filter(r => refKind === 'TODAS' || r.kind === refKind).map(r => <tr key={`${r.kind}:${r.number}`} className="hover:bg-slate-50">
            <td className="px-2.5 py-1.5"><span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-semibold text-slate-700">{r.kind}</span></td>
            <td className="px-2.5 py-1.5 font-semibold text-slate-900">{r.number}</td><td className="px-2.5 py-1.5">{[...r.clients].join(', ') || '—'}</td>
            <td className="px-2.5 py-1.5 text-xs">{r.kind === 'OT' ? '—' : [...r.ots].join(', ') || '—'}</td>
            <td className="px-2.5 py-1.5 text-right tabular-nums">{r.services}</td><td className="px-2.5 py-1.5 text-right tabular-nums">{r.routes.size}</td>
            <td className="px-2.5 py-1.5 text-right tabular-nums">{r.km ? formatKm(r.km) : '—'}</td><td className="px-2.5 py-1.5 text-right tabular-nums">{r.cost ? `S/ ${r.cost.toLocaleString('es-PE', { minimumFractionDigits: 2 })}` : '—'}</td>
            <td className="whitespace-nowrap px-2.5 py-1.5">{r.first === r.last ? shortDate(r.first) : `${shortDate(r.first)} – ${shortDate(r.last)}`}</td>
            <td className="whitespace-nowrap px-2.5 py-1.5 text-right tabular-nums">{r.kg ? `${Math.round(r.kg).toLocaleString('es-PE')} kg` : '—'}</td></tr>)}</tbody></table></div>}
    </div>}
    <p className="text-xs text-slate-600"><b>Estado:</b> Abierta (inicio sin cierre) · En revisión (fin inferido del día siguiente, o alertas de odómetro, GPS, km sin ruta o checklist) · Cerrada (cierre registrado sin alertas). <b>Carga:</b> APT validado por guía (una guía compartida cuenta una vez) o el peso declarado. <b>Ahorro:</b> solo servicios valorizados; no es el margen de la partida.</p>
  </div>
}
