'use client'

import { Fragment, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowDownUp, BarChart3, Box, CalendarDays, ChevronDown, ChevronRight, Coins, Download, ExternalLink, Gauge, LayoutGrid, List, Loader2, Navigation, Route, Scale, Search, Truck, User } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { exportAptXlsx } from '@/lib/apt/export'
import { receiptUrl } from '@/lib/caja'
import { formatKm } from '@/lib/odometer'
import { ALERTS, KM_SOURCE, STATUS, TYPE, applyFilters, bestKm, filtersFrom, fmtDate, fmtTime, fromUnitReport, iso, jornadaKey, references, shortDate, soles,
  sourceText, summarize, tn, type Fleet, type JornadaRow, type JornadaStatus, type Period, type Ref, type View } from '@/lib/jornada'
import { JornadaExpand, StatusBadge } from '@/components/flota/jornada/JornadaPanels'

// Control de Jornada de Transporte (Vista 1, docs/control-jornada-plan.md): jornadas de toda la flota por unidad y día
// (fleet_workdays), con filtros combinables guardados en la dirección, indicadores que siguen a los filtros, tabla
// agrupada, desplegable con los paneles del detalle, vistas por semana y mes, OT/OS/OC/RQ y exportación.

const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 864e5
const n = (v: number | null | undefined) => v == null ? '—' : Number(v).toLocaleString('es-PE', { maximumFractionDigits: 1 })

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
  const idCol = 'bg-[#0b2a4a] px-3 text-left align-middle text-sm font-bold text-white'
  const sortIcon = (k: string) => <ArrowDownUp className={`ml-1 inline h-3.5 w-3.5 ${f.orden.startsWith(`${k}:`) ? 'opacity-100' : 'opacity-40'}`} aria-hidden />
  const sub = (label: string, tone: string, k?: string) => <th key={label} className={`border-l border-white/60 px-2 py-2 text-center text-xs font-semibold ${tone}`}>
    {k ? <button type="button" onClick={() => sortBy(k)} className="font-semibold">{label}{sortIcon(k)}</button> : label}</th>
  const cell = 'whitespace-nowrap border-l border-slate-100 px-2 py-3 text-center tabular-nums'
  const sel = 'h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900'

  return <div className="min-w-0 space-y-4">
    <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-[#0b2a4a] px-5 py-4 text-white shadow">
      <div className="flex items-center gap-4"><Truck className="h-11 w-11" aria-hidden /><div><h1 className="text-2xl font-bold leading-tight">Control de Jornada de Transporte</h1>
        <p className="text-base text-white/85">Seguimiento de unidades, recorridos, carga y costos</p></div></div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <button type="button" onClick={() => setRangeOpen(o => !o)} aria-expanded={rangeOpen} className="inline-flex h-11 items-center gap-3 rounded-xl bg-white px-4 text-base font-medium text-slate-900 shadow-sm">
            <CalendarDays className="h-5 w-5 text-[#0b2a4a]" />{shortLong(from)} – {shortLong(to)}<ChevronDown className="h-4 w-4 text-slate-500" /></button>
          {rangeOpen && <div className="absolute right-0 z-30 mt-2 w-80 space-y-3 rounded-xl border border-slate-200 bg-white p-4 text-slate-900 shadow-xl">
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs font-semibold text-slate-600">Desde<input type="date" value={from} max={to} onChange={e => set({ desde: e.target.value })} className={`${sel} mt-1 w-full`} /></label>
              <label className="text-xs font-semibold text-slate-600">Hasta<input type="date" value={to} min={from} onChange={e => set({ hasta: e.target.value })} className={`${sel} mt-1 w-full`} /></label></div>
            <div className="flex flex-wrap gap-1.5">{([['SEMANA', 'Esta semana'], ['MES', 'Este mes'], ['MES_ANTERIOR', 'Mes anterior'], ['ANIO', 'Últimos 12 meses (una unidad)']] as const).map(([k, label]) =>
              <button key={k} type="button" onClick={() => { preset(k); setRangeOpen(false) }} className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold hover:bg-slate-50">{label}</button>)}</div>
            <p className="text-[11px] text-slate-500">Toda la flota: hasta 3 meses. Con una unidad: hasta 13 meses.</p></div>}
        </div>
        <Link href="/flota/reporte-mensual" className="inline-flex h-11 items-center gap-2 rounded-xl border border-white/60 px-4 text-base font-semibold hover:bg-white/10"><BarChart3 className="h-5 w-5" />Reporte mensual</Link>
        <button type="button" disabled={!rows.length} onClick={exportXlsx} className="inline-flex h-11 items-center gap-2 rounded-xl border border-white/60 px-4 text-base font-semibold hover:bg-white/10 disabled:opacity-50"><Download className="h-5 w-5" />Exportar</button>
      </div>
    </header>

    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">{kpis.map(k => <div key={k.label} className={`flex items-center gap-4 rounded-2xl border border-slate-200 p-4 shadow-sm ${k.card || 'bg-white'}`}>
      <span className={`grid h-14 w-14 shrink-0 place-items-center rounded-full ${k.tone}`}>{k.icon}</span>
      <span className="min-w-0"><span className="block text-sm font-bold text-slate-800">{k.label}</span>
        <span className={`block text-2xl font-extrabold leading-tight ${k.valueTone || 'text-[#0b2a4a]'}`}>{loading ? '…' : k.value}</span>
        {k.hint && <span className="block text-[11px] text-slate-500">{k.hint}</span>}</span></div>)}</div>

    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <label className="flex items-center gap-2 text-sm font-semibold text-slate-800">Conductor<select value={f.conductor} onChange={e => set({ conductor: e.target.value })} className={`${sel} w-48`}>
        <option value="">Todos</option>{drivers.map(d => <option key={d} value={d}>{d}</option>)}</select></label>
      <label className="flex items-center gap-2 text-sm font-semibold text-slate-800">Unidad<select value={f.unidad} onChange={e => set({ unidad: e.target.value })} className={`${sel} w-40`}>
        <option value="">Todas</option>{plates.map(p => <option key={p.plate} value={p.plate}>{p.plate}{p.type ? ` · ${p.type}` : ''}</option>)}</select></label>
      <label className="flex items-center gap-2 text-sm font-semibold text-slate-800">Estado<select value={f.estado} onChange={e => set({ estado: e.target.value })} className={`${sel} w-44`}>
        <option value="">Todos</option>{STATES.map(s => <option key={s} value={s}>{STATUS[s].label}</option>)}</select></label>
      <label className="relative block w-80 max-w-full"><span className="sr-only">Buscar</span><Search aria-hidden className="absolute left-3 top-3 h-4 w-4 text-slate-500" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por OT, OC, OS, RQ, conductor o placa…" className={`${sel} w-full pl-9`} /></label>
      <div className="ml-auto flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">Agrupar<select value={view} onChange={e => setView(e.target.value as View)} className="h-10 rounded-lg border border-slate-300 bg-white px-2 text-sm">
          <option value="DIA">Por día</option><option value="SEMANA">Por semana</option><option value="MES">Por mes</option></select></label>
        <div className="inline-flex overflow-hidden rounded-xl border border-slate-300 bg-white">
          <button type="button" onClick={() => setView('DIA')} aria-pressed className="inline-flex h-10 items-center gap-2 bg-[#0b2a4a] px-4 text-sm font-semibold text-white"><LayoutGrid className="h-4 w-4" />Tabla</button>
          <button type="button" disabled={!rows.length} onClick={() => rows[0] && router.push(detailHref(rows[0]))} className="inline-flex h-10 items-center gap-2 px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"><List className="h-4 w-4" />Detalle</button></div>
      </div>
    </div>

    {long && !f.unidad ? <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-600">Para toda la flota el período es de hasta 3 meses. Elija una unidad para ver un período mayor.</p>
      : loading && !fleet ? <p className="flex items-center justify-center gap-2 rounded-xl bg-white p-10 text-sm text-slate-600"><Loader2 className="h-4 w-4 animate-spin" />Cargando jornadas…</p>
      : !fleet ? null
      : view !== 'DIA' ? <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full text-sm">
          <thead className="bg-[#0b2a4a] text-left text-xs font-bold uppercase text-white"><tr>
            <th className="px-3 py-3">{view === 'MES' ? 'Mes' : 'Semana'}</th><th className="px-3 py-3 text-right">Km recorridos</th><th className="px-3 py-3">Fuente</th>
            <th className="px-3 py-3 text-right">Jornadas</th><th className="px-3 py-3 text-right">Rutas</th><th className="px-3 py-3 text-right">Servicios</th><th className="px-3 py-3 text-right">Peso</th>
            <th className="px-3 py-3">OT</th><th className="px-3 py-3">OS</th><th className="px-3 py-3">OC</th><th className="px-3 py-3">RQ</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{periods.map(p => <tr key={p.key} className={p.days ? 'align-top hover:bg-slate-50' : 'align-top text-slate-400'}>
            <td className="whitespace-nowrap px-3 py-3 font-bold text-[#0b2a4a]">{p.label}</td><td className="px-3 py-3 text-right font-semibold">{p.km ? formatKm(Math.round(p.km * 10) / 10) : '—'}</td>
            <td className="px-3 py-3 text-xs text-slate-600">{sourceText(p) || '—'}{p.daysNoKm > 0 && <span className="block text-amber-700">{p.daysNoKm} jornada(s) operando sin km</span>}</td>
            <td className="px-3 py-3 text-right">{p.days || '—'}</td><td className="px-3 py-3 text-right">{p.routes || '—'}</td><td className="px-3 py-3 text-right">{p.services || '—'}</td>
            <td className="whitespace-nowrap px-3 py-3 text-right">{p.tn ? tn(p.tn) : '—'}</td>
            {[p.ot, p.os, p.oc, p.rq].map((s, i) => <td key={i} className="max-w-56 px-3 py-3 text-xs">{s.size ? [...s].join(', ') : '—'}</td>)}</tr>)}</tbody>
        </table></div>
      : <div className="max-h-[72vh] overflow-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full min-w-[104rem] border-collapse text-sm">
          <thead className="sticky top-0 z-20"><tr>
            <th rowSpan={2} className={`${idCol} w-10`}><span className="sr-only">Desplegar</span></th>
            <th rowSpan={2} className={`${idCol} w-44`}><button type="button" onClick={() => sortBy('fecha')} className="font-bold">Fecha{sortIcon('fecha')}</button></th>
            <th rowSpan={2} className={`${idCol} w-56`}>Conductor / Unidad</th><th rowSpan={2} className={`${idCol} w-24 text-center`}>OT</th><th rowSpan={2} className={`${idCol} w-36 text-center`}>OC / OS / RQ</th>
            <th colSpan={5} className="border-l border-white/60 bg-blue-600 py-2 text-center text-base font-bold text-white">Kilometraje (km)</th>
            <th colSpan={3} className="border-l border-white/60 bg-violet-200 py-2 text-center text-base font-bold text-violet-900">Operación</th>
            <th colSpan={3} className="border-l border-white/60 bg-emerald-300 py-2 text-center text-base font-bold text-emerald-950">Costos (S/)</th>
            <th rowSpan={2} className={`${idCol} w-44 border-l border-white/60 text-center`}><button type="button" onClick={() => sortBy('estado')} className="font-bold">Estado{sortIcon('estado')}</button></th></tr>
            <tr>{sub('Inicio', 'bg-blue-100 text-blue-950')}{sub('Fin', 'bg-blue-100 text-blue-950')}{sub('Recorrido', 'bg-blue-100 text-blue-950', 'km')}{sub('GPS', 'bg-blue-100 text-blue-950')}{sub('Est. ruta', 'bg-blue-100 text-blue-950')}
              {sub('Rutas', 'bg-violet-100 text-violet-950')}{sub('Carga (t)', 'bg-violet-100 text-violet-950', 'carga')}{sub('APT (t)', 'bg-violet-100 text-violet-950')}
              {sub('Valor referencial', 'bg-emerald-100 text-emerald-950')}{sub('Costo real', 'bg-emerald-100 text-emerald-950', 'costo')}{sub('Ahorro', 'bg-emerald-100 text-emerald-950', 'ahorro')}</tr></thead>
          <tbody className="divide-y divide-slate-200">
            {!rows.length && <tr><td colSpan={17} className="p-10 text-center text-slate-500">No hay jornadas para los filtros seleccionados.</td></tr>}
            {rows.map(d => {
              const k = jornadaKey(d), isOpen = open[k], idle = d.status === 'SIN_OPERACION', s = d.saving
              const refs2 = [...d.refs.OC, ...d.refs.OS, ...d.refs.RQ]
              return <Fragment key={k}>
                <tr className={isOpen ? 'bg-blue-50' : idle ? 'bg-slate-50/70 text-slate-500' : 'bg-white hover:bg-slate-50'}>
                  <td className="px-2 py-3 text-center"><button type="button" aria-label={isOpen ? 'Ocultar detalle' : 'Ver detalle'} onClick={() => setOpen(o => ({ ...o, [k]: !o[k] }))}
                    className="grid h-8 w-8 place-items-center rounded-lg text-[#0b2a4a] hover:bg-slate-100">{isOpen ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}</button></td>
                  <td className="px-3 py-3"><span className="flex items-center gap-2 text-base font-bold text-slate-900"><CalendarDays className="h-5 w-5 text-slate-500" />{fmtDate(d.date)}</span>
                    {d.alerts.length > 0 && <span className="mt-1 flex flex-wrap gap-1 pl-7">{d.alerts.map(a => <span key={a} className={`rounded-md px-2 py-0.5 text-xs font-semibold ${ALERTS[a]?.tone || 'bg-slate-100'}`}>{ALERTS[a]?.label || a}</span>)}</span>}</td>
                  <td className="px-3 py-3">{idle && !(d.drivers || []).length ? <span className="text-slate-500">Sin operación</span> : <>
                    <span className="flex items-start gap-2 font-bold uppercase leading-tight text-slate-900"><User className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />{(d.drivers || []).join(', ') || '—'}</span>
                    <span className="mt-1 flex items-center gap-2 font-semibold text-slate-700"><Truck className="h-4 w-4 text-slate-500" />{d.plate}</span></>}
                    {d.checklists > 0 && <span className={`mt-0.5 block pl-6 text-xs font-semibold ${d.operative === false ? 'text-red-700' : 'text-emerald-700'}`}>Checklist {d.operative === false ? 'con observaciones' : 'operativa'}</span>}</td>
                  <td className={`${cell} font-semibold`}>{d.refs.OT.join(', ') || '—'}</td>
                  <td className={`${cell} whitespace-normal font-semibold`}>{refs2.join(', ') || '—'}</td>
                  <td className={cell}>{n(d.odo_start)}</td>
                  <td className={cell}>{n(d.odo_end)}{d.end_source === 'SIGUIENTE_INICIO' && <span className="block text-[11px] font-semibold text-amber-700">inferido</span>}</td>
                  <td className={`${cell} font-bold text-slate-900`}>{n(d.km_odo)}</td><td className={cell}>{n(d.km_gps)}</td><td className={cell}>{n(d.km_est)}</td>
                  <td className={`${cell} font-bold`}>{d.routes || '—'}</td><td className={cell}>{d.tn ? n(d.tn) : '—'}</td><td className={cell}>{d.tn_apt ? n(d.tn_apt) : '—'}</td>
                  <td className={cell}>{s?.valued ? `S/ ${soles(s.value)}` : '—'}</td><td className={cell}>{s?.valued ? `S/ ${soles(s.marginal)}` : '—'}</td>
                  <td className={`${cell} font-bold ${Number(s?.saving) < 0 ? 'text-red-700' : 'text-emerald-700'}`}>{s?.valued ? `S/ ${soles(s.saving)}` : s?.pending ? <span className="text-xs font-semibold text-amber-700">Pendiente</span> : '—'}</td>
                  <td className="border-l border-slate-100 px-2 py-3 text-center"><span className="inline-flex items-center gap-1.5"><StatusBadge status={d.status} />
                    {!idle && d.status && <Link href={detailHref(d)} aria-label="Abrir detalle de la jornada" title="Abrir detalle" className="text-[#0b2a4a]"><ExternalLink className="h-4 w-4" /></Link>}</span>
                    {d.incidents.length > 0 && <span className="mt-1 block text-xs font-bold text-red-700">{d.incidents.length} incidencia(s)</span>}</td>
                </tr>
                {isOpen && <tr className="bg-blue-50/40"><td colSpan={17} className="px-5 py-4"><JornadaExpand r={d} savingsAvailable={!!fleet.savings_available} openPhoto={openPhoto} /></td></tr>}
              </Fragment>
            })}
          </tbody>
        </table></div>}

    {fleet && <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-[#0b2a4a] px-4 py-2.5 text-white">
        <h2 className="text-base font-bold">OT, OS, OC y RQ atendidas</h2>
        <div className="flex flex-wrap gap-1">{(['TODAS', 'OT', 'OS', 'OC', 'RQ'] as const).map(k => <button key={k} type="button" onClick={() => setRefKind(k)} aria-pressed={refKind === k}
          className={`rounded-full px-3 py-1 text-xs font-semibold ${refKind === k ? 'bg-white text-[#0b2a4a]' : 'bg-white/15 text-white hover:bg-white/25'}`}>{k === 'TODAS' ? `Todas (${refs.length})` : `${k} (${refs.filter(r => r.kind === k).length})`}</button>)}</div>
      </div>
      {refs.filter(r => refKind === 'TODAS' || r.kind === refKind).length === 0 ? <p className="p-4 text-sm text-slate-500">Sin {refKind === 'TODAS' ? 'OT ni referencias' : refKind} en el período.</p> :
        <div className="overflow-x-auto"><table className="min-w-full text-sm">
          <thead className="bg-slate-100 text-left text-xs font-bold uppercase text-slate-700"><tr><th className="px-3 py-2">Tipo</th><th className="px-3 py-2">Número</th><th className="px-3 py-2">Cliente</th>
            <th className="px-3 py-2">OT</th><th className="px-3 py-2 text-right">Servicios</th><th className="px-3 py-2 text-right">Rutas</th><th className="px-3 py-2 text-right">Km medidos</th><th className="px-3 py-2 text-right">Costos S/</th><th className="px-3 py-2">Fechas</th><th className="px-3 py-2 text-right">Peso</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{refs.filter(r => refKind === 'TODAS' || r.kind === refKind).map(r => <tr key={`${r.kind}:${r.number}`} className="hover:bg-slate-50">
            <td className="px-3 py-2"><span className="rounded-md bg-blue-100 px-2 py-0.5 text-xs font-bold text-blue-800">{r.kind}</span></td>
            <td className="px-3 py-2 font-bold text-slate-900">{r.number}</td><td className="px-3 py-2">{[...r.clients].join(', ') || '—'}</td>
            <td className="px-3 py-2 text-xs">{r.kind === 'OT' ? '—' : [...r.ots].join(', ') || '—'}</td>
            <td className="px-3 py-2 text-right">{r.services}</td><td className="px-3 py-2 text-right">{r.routes.size}</td>
            <td className="px-3 py-2 text-right">{r.km ? formatKm(r.km) : '—'}</td><td className="px-3 py-2 text-right">{r.cost ? `S/ ${r.cost.toLocaleString('es-PE', { minimumFractionDigits: 2 })}` : '—'}</td>
            <td className="whitespace-nowrap px-3 py-2">{r.first === r.last ? shortDate(r.first) : `${shortDate(r.first)} – ${shortDate(r.last)}`}</td>
            <td className="whitespace-nowrap px-3 py-2 text-right">{r.kg ? `${Math.round(r.kg).toLocaleString('es-PE')} kg` : '—'}</td></tr>)}</tbody></table></div>}
    </div>}
    <p className="text-xs text-slate-600"><b>Estado:</b> Jornada abierta (inicio sin cierre) · En revisión (fin inferido del día siguiente, o alertas de odómetro, GPS, km sin ruta o checklist) · Cerrada (cierre registrado sin alertas). <b>Carga:</b> APT validado por guía (una guía compartida cuenta una vez) o el peso declarado. <b>Ahorro:</b> solo servicios valorizados; no es el margen de la partida.</p>
  </div>
}
