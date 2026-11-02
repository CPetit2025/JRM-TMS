'use client'

import { Fragment, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowDownUp, BarChart3, Box, ChevronDown, ChevronRight, Coins, Download, ExternalLink, Gauge, Loader2, Navigation, Scale, Search, Truck } from 'lucide-react'
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
  const long = days(from, to) > 92

  // Filtros, período y orden en la dirección: el detalle (anterior / siguiente) y el regreso los respetan
  const set = useCallback((changes: Record<string, string>) => {
    const next = new URLSearchParams(params.toString()); next.delete('plate')
    for (const [k, v] of Object.entries(changes)) { if (v) next.set(k, v); else next.delete(k) }
    router.replace(`${path}?${next.toString()}`, { scroll: false })
  }, [params, path, router])

  useEffect(() => { void supabase.rpc('unit_report_plates').then(({ data }) => setPlates((data || []) as { plate: string; type: string | null }[])) }, [supabase])
  const load = useCallback(async () => {
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
  }, [supabase, from, to, long, f.unidad])
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [load])
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
  const SortTh = ({ k, children, className = '' }: { k: string; children: React.ReactNode; className?: string }) => <th className={`px-2 py-2 ${className}`}>
    <button type="button" onClick={() => sortBy(k)} className="inline-flex items-center gap-1 font-semibold uppercase">{children}<ArrowDownUp className={`h-3 w-3 ${f.orden.startsWith(`${k}:`) ? 'text-white' : 'text-white/40'}`} /></button></th>

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

  const kpis: Array<[string, string, React.ReactNode, string?]> = [
    ['Rutas', String(sum(r => r.routes)), <Navigation key="i" className="h-5 w-5" />],
    ['Km odómetro', formatKm(Math.round(sum(r => r.km_odo) * 10) / 10), <Gauge key="i" className="h-5 w-5" />, `${rows.filter(r => r.end_source === 'SIGUIENTE_INICIO').length} jornada(s) con fin inferido`],
    ['Km GPS', formatKm(Math.round(sum(r => r.km_gps) * 10) / 10), <Navigation key="i" className="h-5 w-5" />],
    ['Carga transportada', tn(sum(r => r.tn)), <Box key="i" className="h-5 w-5" />],
    ['Carga APT', tn(sum(r => r.tn_apt)), <Scale key="i" className="h-5 w-5" />],
    ['Ahorro acumulado', fleet?.savings_available ? `S/ ${soles(sum(r => r.saving?.valued ? r.saving.saving : 0))}` : '—', <Coins key="i" className="h-5 w-5" />,
      !fleet?.savings_available ? 'Requiere acceso al control presupuestal (y período de hasta 3 meses)' : pendingSavings ? `${pendingSavings} servicio(s) sin valorizar` : 'Solo servicios valorizados'],
  ]
  const th = 'bg-[#002855] px-2 py-2 text-left text-[11px] font-semibold uppercase text-white'
  const STATES: JornadaStatus[] = ['ABIERTA', 'EN_REVISION', 'CERRADA', 'SIN_OPERACION']

  return <div className="min-w-0 space-y-3">
    <header className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#002855] px-4 py-3 text-white">
      <div className="flex items-center gap-3"><Truck className="h-8 w-8" aria-hidden /><div><h1 className="text-xl font-bold">Control de Jornada de Transporte</h1>
        <p className="text-sm text-white/80">Seguimiento de unidades, recorridos, carga y costos</p></div></div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs">Desde<input type="date" value={from} max={to} onChange={e => set({ desde: e.target.value })} className="ml-1 rounded-md px-2 py-1 text-sm text-slate-900" /></label>
        <label className="text-xs">Hasta<input type="date" value={to} min={from} onChange={e => set({ hasta: e.target.value })} className="ml-1 rounded-md px-2 py-1 text-sm text-slate-900" /></label>
        <Link href="/flota/reporte-mensual" className="inline-flex items-center gap-1.5 rounded-lg border border-white/50 px-3 py-1.5 text-sm font-semibold hover:bg-white/10"><BarChart3 className="h-4 w-4" />Reporte mensual</Link>
        <button type="button" disabled={!rows.length} onClick={exportXlsx} className="inline-flex items-center gap-1.5 rounded-lg border border-white/50 px-3 py-1.5 text-sm font-semibold hover:bg-white/10 disabled:opacity-50"><Download className="h-4 w-4" />Exportar</button>
      </div>
    </header>
    <div className="flex flex-wrap gap-1.5">{([['SEMANA', 'Esta semana'], ['MES', 'Este mes'], ['MES_ANTERIOR', 'Mes anterior'], ['ANIO', 'Últimos 12 meses (una unidad)']] as const).map(([k, label]) =>
      <button key={k} type="button" onClick={() => preset(k)} disabled={loading} className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">{label}</button>)}</div>

    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">{kpis.map(([label, value, icon, hint]) => <div key={label} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-slate-100 text-[#002855]">{icon}</span>
      <span className="min-w-0"><span className="block text-xs font-semibold text-slate-600">{label}</span><span className={`block text-lg font-bold ${label === 'Ahorro acumulado' ? 'text-emerald-700' : 'text-slate-900'}`}>{loading ? '…' : value}</span>
        {hint && <span className="block text-[11px] text-slate-500">{hint}</span>}</span></div>)}</div>

    <div className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-white p-3">
      <label className="text-xs font-semibold text-slate-600">Conductor<select value={f.conductor} onChange={e => set({ conductor: e.target.value })} className="mt-1 block h-9 max-w-56 rounded-lg border border-slate-300 bg-white px-2 text-sm">
        <option value="">Todos</option>{drivers.map(d => <option key={d} value={d}>{d}</option>)}</select></label>
      <label className="text-xs font-semibold text-slate-600">Unidad<select value={f.unidad} onChange={e => set({ unidad: e.target.value })} className="mt-1 block h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm">
        <option value="">Todas</option>{plates.map(p => <option key={p.plate} value={p.plate}>{p.plate}{p.type ? ` · ${p.type}` : ''}</option>)}</select></label>
      <label className="text-xs font-semibold text-slate-600">Estado<select value={f.estado} onChange={e => set({ estado: e.target.value })} className="mt-1 block h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm">
        <option value="">Todos</option>{STATES.map(s => <option key={s} value={s}>{STATUS[s].label}</option>)}</select></label>
      <label className="relative block w-72 max-w-full"><span className="sr-only">Buscar</span><Search aria-hidden className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="OT, OC, OS, RQ, conductor o placa…" className="h-9 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm" /></label>
      <div className="ml-auto inline-flex rounded-lg border border-slate-300 bg-white p-0.5">{([['DIA', 'Tabla'], ['SEMANA', 'Semana'], ['MES', 'Mes']] as const).map(([k, label]) =>
        <button key={k} type="button" onClick={() => setView(k)} aria-pressed={view === k} className={`rounded-md px-3 py-1 text-sm font-medium ${view === k ? 'bg-[#002855] text-white' : 'text-slate-700 hover:bg-slate-50'}`}>{label}</button>)}
        <button type="button" disabled={!rows.length} onClick={() => rows[0] && router.push(detailHref(rows[0]))} className="rounded-md px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">Detalle</button></div>
    </div>

    {long && !f.unidad ? <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">Para toda la flota el período es de hasta 3 meses. Elija una unidad para ver un período mayor.</p>
      : loading && !fleet ? <p className="flex items-center justify-center gap-2 p-8 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Cargando jornadas…</p>
      : !fleet ? null
      : view !== 'DIA' ? <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr>
            <th className="px-3 py-2">{view === 'MES' ? 'Mes' : 'Semana'}</th><th className="px-3 py-2 text-right">Km recorridos</th><th className="px-3 py-2">Fuente</th>
            <th className="px-3 py-2 text-right">Jornadas</th><th className="px-3 py-2 text-right">Rutas</th><th className="px-3 py-2 text-right">Servicios</th><th className="px-3 py-2 text-right">Peso</th>
            <th className="px-3 py-2">OT</th><th className="px-3 py-2">OS</th><th className="px-3 py-2">OC</th><th className="px-3 py-2">RQ</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{periods.map(p => <tr key={p.key} className={p.days ? 'align-top hover:bg-slate-50' : 'align-top text-slate-400'}>
            <td className="whitespace-nowrap px-3 py-2 font-medium">{p.label}</td><td className="px-3 py-2 text-right font-semibold">{p.km ? formatKm(Math.round(p.km * 10) / 10) : '—'}</td>
            <td className="px-3 py-2 text-xs text-slate-600">{sourceText(p) || '—'}{p.daysNoKm > 0 && <span className="block text-amber-700">{p.daysNoKm} jornada(s) operando sin km</span>}</td>
            <td className="px-3 py-2 text-right">{p.days || '—'}</td><td className="px-3 py-2 text-right">{p.routes || '—'}</td><td className="px-3 py-2 text-right">{p.services || '—'}</td>
            <td className="whitespace-nowrap px-3 py-2 text-right">{p.tn ? tn(p.tn) : '—'}</td>
            {[p.ot, p.os, p.oc, p.rq].map((s, i) => <td key={i} className="max-w-56 px-3 py-2 text-xs">{s.size ? [...s].join(', ') : '—'}</td>)}</tr>)}</tbody>
        </table></div>
      : <div className="max-h-[70vh] overflow-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-[96rem] text-sm">
          <thead className="sticky top-0 z-10"><tr>
            <th rowSpan={2} className={th} /><SortTh k="fecha" className={th}>Fecha</SortTh><th rowSpan={2} className={th}>Conductor / unidad</th><th rowSpan={2} className={th}>OT</th><th rowSpan={2} className={th}>OC / OS / RQ</th>
            <th colSpan={5} className="bg-blue-700 px-2 py-1 text-center text-xs font-bold text-white">Kilometraje (km)</th>
            <th colSpan={3} className="bg-violet-200 px-2 py-1 text-center text-xs font-bold text-violet-900">Operación</th>
            <th colSpan={3} className="bg-emerald-300 px-2 py-1 text-center text-xs font-bold text-emerald-950">Costos (S/)</th>
            <SortTh k="estado" className={th}>Estado</SortTh></tr>
            <tr className="bg-slate-100 text-[11px] uppercase text-slate-600">
              <th /><th className="px-2 py-1 text-right">Inicio</th><th className="px-2 py-1 text-right">Fin</th>
              <th className="px-2 py-1 text-right"><button type="button" onClick={() => sortBy('km')} className="uppercase">Recorrido ↕</button></th><th className="px-2 py-1 text-right">GPS</th><th className="px-2 py-1 text-right">Est. ruta</th>
              <th className="px-2 py-1 text-right">Rutas</th><th className="px-2 py-1 text-right"><button type="button" onClick={() => sortBy('carga')} className="uppercase">Carga (t) ↕</button></th><th className="px-2 py-1 text-right">APT (t)</th>
              <th className="px-2 py-1 text-right">Valor referencial</th><th className="px-2 py-1 text-right"><button type="button" onClick={() => sortBy('costo')} className="uppercase">Costo real ↕</button></th>
              <th className="px-2 py-1 text-right"><button type="button" onClick={() => sortBy('ahorro')} className="uppercase">Ahorro ↕</button></th><th /></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {!rows.length && <tr><td colSpan={17} className="p-8 text-center text-slate-500">No hay jornadas para los filtros seleccionados.</td></tr>}
            {rows.map(d => {
              const k = jornadaKey(d), isOpen = open[k], idle = d.status === 'SIN_OPERACION', s = d.saving
              return <Fragment key={k}>
                <tr className={`${d.status ? STATUS[d.status].row : ''} ${isOpen ? 'bg-blue-50/40' : 'hover:bg-slate-50'}`}>
                  <td className="px-2 py-2">{!idle && <button type="button" aria-label={isOpen ? 'Ocultar detalle' : 'Ver detalle'} onClick={() => setOpen(o => ({ ...o, [k]: !o[k] }))}>{isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button>}</td>
                  <td className="whitespace-nowrap px-2 py-2 font-medium">{fmtDate(d.date)}
                    {d.alerts.length > 0 && <span className="mt-0.5 flex flex-wrap gap-1">{d.alerts.map(a => <span key={a} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${ALERTS[a]?.tone || 'bg-slate-100'}`}>{ALERTS[a]?.label || a}</span>)}</span>}</td>
                  <td className="px-2 py-2 text-xs">{idle ? 'Sin operación' : <><b className="block text-sm">{(d.drivers || []).join(', ') || '—'}</b></>}<span className="text-slate-500">{d.plate}</span>
                    {d.checklists > 0 && <span className={`block text-[11px] ${d.operative === false ? 'text-red-700' : 'text-emerald-700'}`}>Checklist: {d.checklists} · {d.operative === false ? 'con observaciones' : 'operativa'}</span>}</td>
                  <td className="px-2 py-2 text-xs">{d.refs.OT.join(', ') || '—'}</td>
                  <td className="px-2 py-2 text-xs">{[...d.refs.OC.map(x => `OC ${x}`), ...d.refs.OS.map(x => `OS ${x}`), ...d.refs.RQ.map(x => `RQ ${x}`)].join(', ') || '—'}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{n(d.odo_start)}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{n(d.odo_end)}{d.end_source === 'SIGUIENTE_INICIO' && <span className="block text-[10px] text-amber-700">inferido</span>}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right font-semibold tabular-nums">{n(d.km_odo)}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{n(d.km_gps)}</td><td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{n(d.km_est)}</td>
                  <td className="px-2 py-2 text-right">{d.routes || '—'}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{d.tn ? n(d.tn) : '—'}</td><td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{d.tn_apt ? n(d.tn_apt) : '—'}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{s?.valued ? soles(s.value) : '—'}</td>
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{s?.valued ? soles(s.marginal) : '—'}</td>
                  <td className={`whitespace-nowrap px-2 py-2 text-right font-semibold tabular-nums ${Number(s?.saving) < 0 ? 'text-red-700' : 'text-emerald-700'}`}>{s?.valued ? soles(s.saving) : s?.pending ? <span className="text-xs font-normal text-amber-700">pendiente</span> : '—'}</td>
                  <td className="px-2 py-2"><span className="flex items-center gap-1"><StatusBadge status={d.status} />
                    {!idle && d.status && <Link href={detailHref(d)} aria-label="Abrir detalle de la jornada" className="text-[#002855]"><ExternalLink className="h-4 w-4" /></Link>}</span>
                    {d.incidents.length > 0 && <span className="mt-0.5 block text-[11px] font-semibold text-red-700">{d.incidents.length} incidencia(s)</span>}</td>
                </tr>
                {isOpen && <tr><td colSpan={17} className="bg-slate-50 px-4 py-3"><JornadaExpand r={d} savingsAvailable={!!fleet.savings_available} openPhoto={openPhoto} /></td></tr>}
              </Fragment>
            })}
          </tbody>
        </table></div>}

    {fleet && <div className="rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
        <h2 className="text-sm font-semibold text-slate-800">OT, OS, OC y RQ atendidas</h2>
        <div className="flex flex-wrap gap-1">{(['TODAS', 'OT', 'OS', 'OC', 'RQ'] as const).map(k => <button key={k} type="button" onClick={() => setRefKind(k)} aria-pressed={refKind === k}
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${refKind === k ? 'bg-[#002855] text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}>{k === 'TODAS' ? `Todas (${refs.length})` : `${k} (${refs.filter(r => r.kind === k).length})`}</button>)}</div>
      </div>
      {refs.filter(r => refKind === 'TODAS' || r.kind === refKind).length === 0 ? <p className="p-4 text-sm text-slate-500">Sin {refKind === 'TODAS' ? 'OT ni referencias' : refKind} en el período.</p> :
        <div className="overflow-x-auto"><table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-3 py-2">Tipo</th><th className="px-3 py-2">Número</th><th className="px-3 py-2">Cliente</th>
            <th className="px-3 py-2">OT</th><th className="px-3 py-2 text-right">Servicios</th><th className="px-3 py-2 text-right">Rutas</th><th className="px-3 py-2 text-right">Km medidos</th><th className="px-3 py-2 text-right">Costos S/</th><th className="px-3 py-2">Fechas</th><th className="px-3 py-2 text-right">Peso</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{refs.filter(r => refKind === 'TODAS' || r.kind === refKind).map(r => <tr key={`${r.kind}:${r.number}`} className="hover:bg-slate-50">
            <td className="px-3 py-2"><span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-700">{r.kind}</span></td>
            <td className="px-3 py-2 font-medium">{r.number}</td><td className="px-3 py-2">{[...r.clients].join(', ') || '—'}</td>
            <td className="px-3 py-2 text-xs">{r.kind === 'OT' ? '—' : [...r.ots].join(', ') || '—'}</td>
            <td className="px-3 py-2 text-right">{r.services}</td><td className="px-3 py-2 text-right">{r.routes.size}</td>
            <td className="px-3 py-2 text-right">{r.km ? formatKm(r.km) : '—'}</td><td className="px-3 py-2 text-right">{r.cost ? `S/ ${r.cost.toLocaleString('es-PE', { minimumFractionDigits: 2 })}` : '—'}</td>
            <td className="whitespace-nowrap px-3 py-2">{r.first === r.last ? shortDate(r.first) : `${shortDate(r.first)} – ${shortDate(r.last)}`}</td>
            <td className="whitespace-nowrap px-3 py-2 text-right">{r.kg ? `${Math.round(r.kg).toLocaleString('es-PE')} kg` : '—'}</td></tr>)}</tbody></table></div>}
    </div>}
    <p className="text-xs text-slate-500">Estado: Abierta (inicio sin cierre), En revisión (fin inferido del día siguiente o alertas de odómetro, GPS, km sin ruta o checklist), Cerrada (cierre registrado sin alertas). Carga: APT validado por guía (una guía compartida cuenta una vez) o el peso declarado. El ahorro suma solo servicios valorizados; no es el margen de la partida.</p>
  </div>
}
