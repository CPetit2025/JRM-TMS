'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Download, Image as ImageIcon, Loader2, Search } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { exportAptXlsx } from '@/lib/apt/export'
import { receiptUrl } from '@/lib/caja'
import { formatKm } from '@/lib/odometer'

type Stop = { sequence: number; status: string; request_number: string; type: string; ot: string | null; client: string | null; reference_supplier: string | null; origin: string | null; destination: string | null
  km_leg: number | null; km_source: 'GPS_COMPLETO' | 'ODOMETRO' | 'GPS_PARCIAL' | 'SIN_DATO' | null; odo_reading: number | null; odo_photo: string | null; odo_flag: string | null; guide: string | null; kg: number | null; kg_source: 'APT' | 'DECLARADO' | null; ref_type: 'OS' | 'OC' | 'RQ' | null; ref_number: string | null }
type Dispatch = { dispatch_number: string; status: string; driver: string | null; modalidad: string | null; departure: string; km_gps: number | null; km_real_source: 'GPS' | 'ODOMETRO' | null
  km_real: number | null; km_est: number | null; cost_total: number; cost_applied: number; cost_pending: number
  costs?: Array<{ kind: string; amount_pen: number; basis: string; status: string; request_number: string | null; ot: string | null; expense_type: string | null; fuel_gallons: number | null; fuel_odometer: number | null; estimated: boolean }>; stops: Stop[] }
type Reading = { kind: 'INICIO' | 'CIERRE'; odometer: number; at: string; photo: string; flag: string | null }
type Day = { date: string; drivers: string[] | null; checklists: number; operative: boolean | null; odo_start: number | null; odo_end: number | null
  end_source: 'CIERRE' | 'SIGUIENTE_INICIO' | null; km_odo: number | null; km_gps: number | null; km_real: number | null; km_est: number | null; routes: number; services: number; ots: number; clients: number
  cost_total: number; cost_applied: number; cost_pending: number; tn: number | null; tn_apt: number | null; readings: Reading[]; dispatches: Dispatch[]; alerts: string[] }
type Report = { success: boolean; error?: string; plate: string; type: string | null; current_odometer: number | null; from: string; to: string
  totals: { days_active: number; routes: number; services: number; ots: number; km_odo: number; km_gps: number; km_real: number; km_est: number; cost_total: number; cost_applied: number; cost_pending: number; days_with_odo: number; tn: number; tn_apt: number; checklists: number }
  days: Day[] }

const ALERTS: Record<string, { label: string; tone: string }> = {
  SIN_CHECKLIST: { label: 'Ruta sin checklist', tone: 'bg-red-100 text-red-800' },
  SIN_ODOMETRO: { label: 'Sin odómetro', tone: 'bg-amber-100 text-amber-800' },
  SIN_CIERRE: { label: 'Sin cierre de jornada', tone: 'bg-slate-100 text-slate-700' },
  KM_SIN_RUTA: { label: 'Km sin ruta', tone: 'bg-orange-100 text-orange-800' },
  GPS_INCOMPLETO: { label: 'GPS incompleto', tone: 'bg-amber-100 text-amber-800' },
  ODOMETRO_RETROCEDE: { label: 'Odómetro retrocede', tone: 'bg-red-100 text-red-800' },
  ODOMETRO_SALTO: { label: 'Salto de odómetro', tone: 'bg-red-100 text-red-800' },
}
const iso = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Lima' })
const fmtDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('es-PE', { weekday: 'short', day: '2-digit', month: 'short' })
const fmtTime = (d: string) => new Date(d).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })
const tn = (v: number | null | undefined) => v == null ? '—' : `${Number(v).toLocaleString('es-PE', { maximumFractionDigits: 2 })} t`
const TYPE: Record<string, string> = { DESPACHO: 'Entrega', RECOJO: 'Recojo', TRASLADO: 'Traslado' }
const num = (v: number | null | undefined) => v == null ? null : Number(v)

// El odómetro se concilia por jornada; no debe confundirse con los km atribuibles a una ruta.
type KmSource = 'GPS' | 'REAL' | 'ESTIMADO'
const KM_SOURCE: Record<KmSource, string> = { GPS: 'GPS', REAL: 'Real de ruta', ESTIMADO: 'Estimado' }
function bestKm(d: Day): { km: number; source: KmSource } | null {
  const options: Array<[number | null, KmSource]> = [[num(d.km_real), 'REAL'], [num(d.km_gps), 'GPS'], [num(d.km_est), 'ESTIMADO']]
  const hit = options.find(([km]) => km != null && km > 0)
  return hit ? { km: hit[0]!, source: hit[1] } : null
}

type View = 'DIA' | 'SEMANA' | 'MES'
const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
const weekStart = (d: string) => addDays(d, -((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7))
const MONTH = new Intl.DateTimeFormat('es-PE', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const shortDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', timeZone: 'UTC' })

type Period = { key: string; label: string; from: string; to: string; days: number; km: number; bySource: Partial<Record<KmSource, number>>; daysNoKm: number
  routes: number; services: number; tn: number; ot: Set<string>; os: Set<string>; oc: Set<string>; rq: Set<string> }
type Ref = { kind: 'OT' | 'OS' | 'OC' | 'RQ'; number: string; clients: Set<string>; ots: Set<string>; services: number; routes: Set<string>; first: string; last: string; kg: number; km: number; cost: number }

function summarize(days: Day[], view: Exclude<View, 'DIA'>) {
  const periods = new Map<string, Period>()
  for (const d of days) {
    const key = view === 'MES' ? d.date.slice(0, 7) : weekStart(d.date)
    let p = periods.get(key)
    if (!p) {
      const label = view === 'MES' ? MONTH.format(new Date(`${key}-01T12:00:00Z`)) : `Semana del ${shortDate(key)} al ${shortDate(addDays(key, 6))}`
      p = { key, label: label.charAt(0).toUpperCase() + label.slice(1), from: d.date, to: d.date, days: 0, km: 0, bySource: {}, daysNoKm: 0, routes: 0, services: 0, tn: 0,
        ot: new Set(), os: new Set(), oc: new Set(), rq: new Set() }
      periods.set(key, p)
    }
    p.to = d.date
    const km = bestKm(d)
    if (d.routes || d.checklists || d.readings.length) { p.days += 1; if (!km) p.daysNoKm += 1 }
    if (km) { p.km += km.km; p.bySource[km.source] = (p.bySource[km.source] || 0) + km.km }
    p.routes += d.routes; p.services += d.services; p.tn += Number(d.tn || 0)
    for (const x of d.dispatches) for (const s of x.stops) {
      if (s.ot) p.ot.add(s.ot)
      if (s.ref_type && s.ref_number) ({ OS: p.os, OC: p.oc, RQ: p.rq })[s.ref_type]?.add(s.ref_number)
    }
  }
  return [...periods.values()]
}

function references(days: Day[]) {
  const refs = new Map<string, Ref>()
  const touch = (kind: Ref['kind'], number: string, d: Day, x: Dispatch, s: Stop) => {
    const key = `${kind}:${number}`
    let r = refs.get(key)
    if (!r) { r = { kind, number, clients: new Set(), ots: new Set(), services: 0, routes: new Set(), first: d.date, last: d.date, kg: 0, km: 0, cost: 0 }; refs.set(key, r) }
    if (s.client) r.clients.add(s.client)
    if (kind !== 'OT' && s.ot) r.ots.add(s.ot)
    r.services += 1; r.routes.add(x.dispatch_number); r.last = d.date; r.kg += Number(s.kg || 0); r.km += Number(s.km_leg || 0)
    r.cost += (x.costs || []).filter(c => c.request_number === s.request_number && c.status !== 'ANULADO').reduce((sum, c) => sum + Number(c.amount_pen || 0), 0)
  }
  for (const d of days) for (const x of d.dispatches) for (const s of x.stops) {
    if (s.ot) touch('OT', s.ot, d, x, s)
    if (s.ref_type && s.ref_number) touch(s.ref_type, s.ref_number, d, x, s)
  }
  const order = { OT: 0, OS: 1, OC: 2, RQ: 3 }
  return [...refs.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.number.localeCompare(b.number, 'es', { numeric: true }))
}
const sourceText = (p: Period) => (Object.entries(p.bySource) as Array<[KmSource, number]>).filter(([, km]) => km > 0)
  .map(([s, km]) => `${KM_SOURCE[s]} ${formatKm(Math.round(km * 10) / 10)}`).join(' · ')

export default function ReporteUnidadPage() {
  const supabase = useMemo(() => createClient(), [])
  const [plates, setPlates] = useState<{ plate: string; type: string | null }[]>([])
  const [plate, setPlate] = useState('')
  const [from, setFrom] = useState(() => iso(new Date(Date.now() - 6 * 86400000)))
  const [to, setTo] = useState(() => iso(new Date()))
  const [report, setReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [view, setView] = useState<View>('DIA')
  const [refKind, setRefKind] = useState<'TODAS' | Ref['kind']>('TODAS')
  const periods = useMemo(() => report && view !== 'DIA' ? summarize(report.days, view) : [], [report, view])
  const refs = useMemo(() => report ? references(report.days) : [], [report])
  const totalKm = useMemo(() => report ? report.days.reduce((sum, d) => sum + (bestKm(d)?.km || 0), 0) : 0, [report])
  const refCount = (kind: Ref['kind']) => refs.filter(r => r.kind === kind).length

  const run = useCallback(async (p: string, f: string, t: string) => {
    if (!p) return
    setLoading(true)
    const { data, error } = await supabase.rpc('unit_daily_report', { p_plate: p, p_from: f, p_to: t })
    setLoading(false)
    if (error || !data?.success) { toast.error(data?.error || error?.message || 'No se pudo cargar el reporte'); return }
    setReport(data as Report); setOpen({})
  }, [supabase])

  useEffect(() => {
    let cancel = false
    supabase.rpc('unit_report_plates').then(({ data }) => {
      if (cancel) return
      const list = (data || []) as { plate: string; type: string | null }[]
      setPlates(list)
      const initial = new URLSearchParams(window.location.search).get('plate')
      const chosen = initial && list.some(x => x.plate === initial) ? initial : ''
      if (chosen) { setPlate(chosen); void run(chosen, from, to) }
    })
    return () => { cancel = true }
    // Solo al abrir: la placa puede venir de Flota 360°
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase])

  const preset = (kind: 'SEMANA' | 'MES' | 'MES_ANTERIOR' | 'ANIO') => {
    const today = iso(new Date())
    let f = today, t = today
    if (kind === 'SEMANA') f = weekStart(today)
    else if (kind === 'MES') f = `${today.slice(0, 7)}-01`
    else if (kind === 'MES_ANTERIOR') { t = addDays(`${today.slice(0, 7)}-01`, -1); f = `${t.slice(0, 7)}-01` }
    else { const m = new Date(`${today.slice(0, 7)}-01T12:00:00Z`); m.setUTCMonth(m.getUTCMonth() - 11); f = m.toISOString().slice(0, 10) }
    setFrom(f); setTo(t)
    setView(kind === 'SEMANA' ? 'DIA' : kind === 'ANIO' ? 'MES' : 'SEMANA')
    if (plate) void run(plate, f, t)
  }

  const openPhoto = async (path: string) => {
    const url = await receiptUrl(supabase, path)
    if (url) window.open(url, '_blank', 'noopener'); else toast.error('No tiene acceso a la foto')
  }

  const periodRow = (p: Period) => ({ Periodo: p.label, Desde: p.from, Hasta: p.to, 'Días operando': p.days, 'Km recorridos': Math.round(p.km * 10) / 10,
    'Fuente km': sourceText(p), 'Días sin km': p.daysNoKm, Rutas: p.routes, Servicios: p.services, Toneladas: Math.round(p.tn * 100) / 100,
    OT: [...p.ot].join(', '), OS: [...p.os].join(', '), OC: [...p.oc].join(', '), RQ: [...p.rq].join(', ') })

  const exportXlsx = () => {
    if (!report) return
    exportAptXlsx(`Reporte_unidad_${report.plate}_${report.from}_${report.to}`, {
      'Resumen diario': report.days.map(d => ({
        Fecha: d.date, Conductores: (d.drivers || []).join(', '), Checklists: d.checklists, 'Operativa': d.operative == null ? '' : d.operative ? 'Sí' : 'No',
        'Odómetro inicio': d.odo_start, 'Odómetro fin': d.odo_end, 'Fuente fin': d.end_source === 'SIGUIENTE_INICIO' ? 'Inicio del día siguiente' : d.end_source === 'CIERRE' ? 'Cierre de jornada' : '',
        'Km por ruta': bestKm(d)?.km ?? null, 'Fuente km ruta': bestKm(d) ? KM_SOURCE[bestKm(d)!.source] : '',
        'Km odómetro': d.km_odo, 'Km GPS': d.km_gps, 'Km real rutas': d.km_real, 'Km estimado rutas': d.km_est, Rutas: d.routes, Servicios: d.services, OT: d.ots, Clientes: d.clients, 'Toneladas': d.tn, 'Toneladas APT': d.tn_apt,
        'Costo rutas (S/)': d.cost_total, 'Costo aplicado (S/)': d.cost_applied, 'Costo pendiente (S/)': d.cost_pending,
        Alertas: d.alerts.map(a => ALERTS[a]?.label || a).join(', '),
      })),
      'Km por semana': summarize(report.days, 'SEMANA').map(periodRow),
      'Km por mes': summarize(report.days, 'MES').map(periodRow),
      'OT, OS, OC y RQ': refs.map(r => ({ Tipo: r.kind, Número: r.number, Cliente: [...r.clients].join(', '), 'OT relacionada': [...r.ots].join(', '),
        Servicios: r.services, Rutas: r.routes.size, 'Km medidos': Math.round(r.km * 1000) / 1000, 'Costos asignados S/': Math.round(r.cost * 100) / 100, 'Primera fecha': r.first, 'Última fecha': r.last, 'Peso kg': r.kg || null })),
      Servicios: report.days.flatMap(d => d.dispatches.flatMap(x => x.stops.map(s => ({
        Fecha: d.date, Ruta: x.dispatch_number, Estado_ruta: x.status, Conductor: x.driver, 'Km GPS ruta': x.km_gps, 'Km real ruta': x.km_real, 'Fuente km real': x.km_real_source, Parada: s.sequence, Solicitud: s.request_number,
        Tipo: TYPE[s.type] || s.type, OT: s.ot, 'Tipo ref.': s.ref_type, 'N° ref.': s.ref_number, Proveedor_referencia: s.reference_supplier, Cliente: s.client, Origen: s.origin, Destino: s.destination, 'Km tramo': s.km_leg, Odometro_parada: s.odo_reading, Alerta_odometro: s.odo_flag, Guía: s.guide, 'Peso kg': s.kg,
        'Fuente peso': s.kg_source === 'APT' ? 'APT validado' : s.kg_source === 'DECLARADO' ? 'Declarado en solicitud' : '', Fuente_km_tramo: s.km_source || 'Sin dato', Estado: s.status,
      })))),
      'Costos por ruta y OT': report.days.flatMap(d => d.dispatches.flatMap(x => (x.costs || []).map(c => ({
        Fecha: d.date, Ruta: x.dispatch_number, Estado_ruta: x.status, Placa: report.plate, Conductor: x.driver,
        OT: c.ot, Solicitud: c.request_number, Tipo: c.expense_type || c.kind, Importe_S: c.amount_pen,
        Estado: c.status, Base_imputacion: c.basis, Galones_asignados: c.fuel_gallons, Odometro_abastecimiento: c.fuel_odometer, Estimado: c.estimated ? 'Sí' : 'No',
      })))),
      'Lecturas odómetro': report.days.flatMap(d => d.readings.map(r => ({ Fecha: d.date, Tipo: r.kind === 'INICIO' ? 'Inicio (checklist)' : 'Cierre de jornada', Hora: fmtTime(r.at), Odómetro: r.odometer, Observación: r.flag || '' }))),
    })
  }

  const t = report?.totals
  const card = 'rounded-xl border border-slate-200 bg-white p-3'
  return <div className="space-y-4">
    <PageHeader title="Reporte por unidad" description="Km conciliados por odómetro y por ruta, OT atendidas, gastos operativos y costos imputados." actions={report && <button type="button" onClick={exportXlsx} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"><Download className="h-4 w-4" />Excel</button>} />
    <form onSubmit={e => { e.preventDefault(); void run(plate, from, to) }} className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3">
      <label className="text-xs font-medium text-slate-600">Unidad
        <select value={plate} onChange={e => setPlate(e.target.value)} className="mt-1 block min-w-40 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
          <option value="">Seleccione la placa</option>{plates.map(p => <option key={p.plate} value={p.plate}>{p.plate}{p.type ? ` · ${p.type}` : ''}</option>)}
        </select></label>
      <label className="text-xs font-medium text-slate-600">Desde<input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm" /></label>
      <label className="text-xs font-medium text-slate-600">Hasta<input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm" /></label>
      <button type="submit" disabled={!plate || loading} className="inline-flex items-center gap-1.5 rounded-lg bg-[#002855] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}Consultar</button>
      <div className="flex flex-wrap gap-1.5">{([['SEMANA', 'Esta semana'], ['MES', 'Este mes'], ['MES_ANTERIOR', 'Mes anterior'], ['ANIO', 'Últimos 12 meses']] as const).map(([k, label]) =>
        <button key={k} type="button" onClick={() => preset(k)} disabled={loading} className="rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">{label}</button>)}</div>
      <p className="w-full text-xs text-slate-500">Hasta 13 meses. Los km por ruta usan GPS, km real o estimado. El odómetro con foto se presenta por separado como total de jornada para conciliación; no se distribuye entre rutas.</p>
    </form>

    {!report ? <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">Elija una unidad y el período para ver su operación diaria.</p> : <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        {[
          ['Km por ruta', formatKm(Math.round(totalKm * 10) / 10), `GPS ${formatKm(t?.km_gps)} · odómetro diario ${formatKm(t?.km_odo)}`], ['Días operando', t?.days_active, `${t?.checklists || 0} checklist(s)`],
          ['Rutas', t?.routes], ['Servicios', t?.services], ['OT atendidas', t?.ots], ['OS · OC · RQ', `${refCount('OS')} · ${refCount('OC')} · ${refCount('RQ')}`, 'Referencias de compra atendidas'],
          ['Peso transportado', tn(t?.tn), `APT validado: ${tn(t?.tn_apt)}`], ['Odómetro', `${t?.days_with_odo || 0} día(s)`, 'con lectura completa'],
          ['Costo de rutas', `S/ ${Number(t?.cost_total || 0).toLocaleString('es-PE', { minimumFractionDigits: 2 })}`, `Aplicado S/ ${Number(t?.cost_applied || 0).toLocaleString('es-PE', { minimumFractionDigits: 2 })} · pendiente S/ ${Number(t?.cost_pending || 0).toLocaleString('es-PE', { minimumFractionDigits: 2 })}`],
        ].map(([label, value, hint]) => <div key={String(label)} className={card}><p className="text-xs text-slate-500">{label}</p><p className="text-lg font-bold text-slate-900">{value ?? '—'}</p>{hint && <p className="text-[11px] text-slate-500">{hint}</p>}</div>)}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-slate-700">Ver por</span>
        <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5">{([['DIA', 'Día'], ['SEMANA', 'Semana'], ['MES', 'Mes']] as const).map(([k, label]) =>
          <button key={k} type="button" onClick={() => setView(k)} aria-pressed={view === k} className={`rounded-md px-3 py-1 text-sm font-medium ${view === k ? 'bg-[#002855] text-white' : 'text-slate-700 hover:bg-slate-50'}`}>{label}</button>)}</div>
      </div>

      {view !== 'DIA' ? <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr>
            <th className="px-3 py-2">{view === 'MES' ? 'Mes' : 'Semana'}</th><th className="px-3 py-2 text-right">Km recorridos</th><th className="px-3 py-2">Fuente</th>
            <th className="px-3 py-2 text-right">Días</th><th className="px-3 py-2 text-right">Rutas</th><th className="px-3 py-2 text-right">Servicios</th><th className="px-3 py-2 text-right">Peso</th>
            <th className="px-3 py-2">OT</th><th className="px-3 py-2">OS</th><th className="px-3 py-2">OC</th><th className="px-3 py-2">RQ</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {periods.map(p => <tr key={p.key} className={p.days ? 'align-top hover:bg-slate-50' : 'align-top text-slate-400'}>
              <td className="whitespace-nowrap px-3 py-2 font-medium">{p.label}</td>
              <td className="px-3 py-2 text-right font-semibold">{p.km ? formatKm(Math.round(p.km * 10) / 10) : '—'}</td>
              <td className="px-3 py-2 text-xs text-slate-600">{sourceText(p) || '—'}{p.daysNoKm > 0 && <span className="block text-amber-700">{p.daysNoKm} día(s) operando sin km</span>}</td>
              <td className="px-3 py-2 text-right">{p.days || '—'}</td><td className="px-3 py-2 text-right">{p.routes || '—'}</td><td className="px-3 py-2 text-right">{p.services || '—'}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right">{p.tn ? tn(p.tn) : '—'}</td>
              {[p.ot, p.os, p.oc, p.rq].map((set, i) => <td key={i} className="max-w-56 px-3 py-2 text-xs">{set.size ? [...set].join(', ') : '—'}</td>)}
            </tr>)}
          </tbody>
        </table>
      </div> : <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr>
            <th className="px-3 py-2" /><th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Conductor(es)</th><th className="px-3 py-2">Checklist</th>
            <th className="px-3 py-2">Odómetro</th><th className="px-3 py-2 text-right">Km recorridos</th><th className="px-3 py-2 text-right">Km GPS</th>
            <th className="px-3 py-2 text-right">Rutas</th><th className="px-3 py-2 text-right">Servicios</th><th className="px-3 py-2 text-right">OT</th><th className="px-3 py-2 text-right">Peso</th><th className="px-3 py-2">Alertas</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {report.days.map(d => {
              const idle = !d.routes && !d.checklists && !d.readings.length
              const isOpen = open[d.date]
              return <Fragment key={d.date}>
                <tr className={idle ? 'text-slate-400' : 'hover:bg-slate-50'}>
                  <td className="px-3 py-2">{!idle && <button type="button" aria-label={isOpen ? 'Ocultar detalle' : 'Ver detalle'} onClick={() => setOpen(o => ({ ...o, [d.date]: !o[d.date] }))}>{isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button>}</td>
                  <td className="whitespace-nowrap px-3 py-2 font-medium">{fmtDate(d.date)}</td>
                  <td className="px-3 py-2">{idle ? 'Sin operación' : (d.drivers || []).join(', ') || '—'}</td>
                  <td className="px-3 py-2">{d.checklists ? <span className={d.operative === false ? 'text-red-700' : 'text-emerald-700'}>{d.checklists} · {d.operative === false ? 'con observaciones' : 'operativa'}</span> : '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2">{d.odo_start != null ? formatKm(d.odo_start) : '—'} → {d.odo_end != null ? formatKm(d.odo_end) : '—'}{d.end_source === 'SIGUIENTE_INICIO' && <span className="block text-[11px] text-slate-500">fin = inicio del día siguiente</span>}</td>
                  <td className="px-3 py-2 text-right font-semibold">{(() => { const k = bestKm(d); return k ? <>{formatKm(k.km)}<span className="block text-[11px] font-normal text-slate-500">{KM_SOURCE[k.source].toLowerCase()}</span></> : '—' })()}</td>
                  <td className="px-3 py-2 text-right">{d.km_gps != null ? formatKm(d.km_gps) : '—'}</td>
                  <td className="px-3 py-2 text-right">{d.routes || '—'}</td><td className="px-3 py-2 text-right">{d.services || '—'}</td><td className="px-3 py-2 text-right">{d.ots || '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">{d.tn ? tn(d.tn) : '—'}</td>
                  <td className="px-3 py-2"><div className="flex flex-wrap gap-1">{d.alerts.map(a => <span key={a} className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${ALERTS[a]?.tone || 'bg-slate-100'}`}>{ALERTS[a]?.label || a}</span>)}</div></td>
                </tr>
                {isOpen && <tr><td colSpan={12} className="bg-slate-50 px-6 py-3">
                  {d.readings.length > 0 && <div className="mb-3 flex flex-wrap gap-2 text-xs">{d.readings.map((r, i) => <button key={i} type="button" onClick={() => void openPhoto(r.photo)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 hover:bg-slate-100">
                    <ImageIcon className="h-3.5 w-3.5" />{r.kind === 'INICIO' ? 'Inicio' : 'Cierre'} {fmtTime(r.at)} · {formatKm(r.odometer)}{r.flag && <b className="text-red-700"> · {r.flag === 'RETROCESO' ? 'retrocede' : 'salto'}</b>}</button>)}</div>}
                  {d.dispatches.length === 0 ? <p className="text-xs text-slate-500">Sin rutas este día.</p> : d.dispatches.map(x => <div key={x.dispatch_number} className="mb-3">
                    <p className="text-xs font-semibold text-slate-700">Ruta {x.dispatch_number} · {x.status} · {x.driver || '—'} · salida {fmtTime(x.departure)} · GPS {formatKm(x.km_gps)}{x.km_real != null && ` · real ${formatKm(x.km_real)} (${x.km_real_source === 'ODOMETRO' ? 'odómetro' : x.km_real_source === 'GPS' ? 'GPS' : 'sin fuente'})`}{x.km_est != null && ` · estimado ${formatKm(x.km_est)}`} · Costo S/ {Number(x.cost_total || 0).toLocaleString('es-PE', { minimumFractionDigits: 2 })} ({Number(x.cost_pending || 0) > 0 ? `pendiente S/ ${Number(x.cost_pending).toLocaleString('es-PE', { minimumFractionDigits: 2 })}` : 'aplicado'})</p>
                    {(x.costs || []).length > 0 && <div className="my-1 overflow-x-auto rounded border border-slate-200 bg-white"><table className="min-w-full text-xs"><thead className="bg-slate-100 text-left text-slate-500"><tr><th className="px-2 py-1">Concepto</th><th className="px-2 py-1">OT</th><th className="px-2 py-1">Solicitud</th><th className="px-2 py-1">Origen / reparto</th><th className="px-2 py-1 text-right">Galones</th><th className="px-2 py-1 text-right">Odómetro carga</th><th className="px-2 py-1">Estado</th><th className="px-2 py-1 text-right">Importe</th></tr></thead><tbody>{(x.costs || []).map((c, i) => <tr key={`${c.kind}-${c.request_number}-${i}`} className="border-t border-slate-100"><td className="px-2 py-1">{c.expense_type || c.kind}{c.estimated ? ' · estimado' : ''}</td><td className="px-2 py-1">{c.ot || 'Sin OT'}</td><td className="px-2 py-1">{c.request_number || '—'}</td><td className="px-2 py-1">{c.basis === 'DIRECTO' ? 'Directo' : c.basis === 'PESO' ? 'Por peso' : 'Partes iguales'}</td><td className="px-2 py-1 text-right">{c.fuel_gallons == null ? '—' : Number(c.fuel_gallons).toLocaleString('es-PE', { maximumFractionDigits: 3 })}</td><td className="px-2 py-1 text-right">{c.fuel_odometer == null ? '—' : formatKm(c.fuel_odometer)}</td><td className="px-2 py-1">{c.status === 'APLICADO' ? 'Aplicado' : c.status === 'PENDIENTE' ? 'Pendiente de cierre' : 'Anulado'}</td><td className="px-2 py-1 text-right">S/ {Number(c.amount_pen).toLocaleString('es-PE', { minimumFractionDigits: 2 })}</td></tr>)}</tbody></table></div>}
                    <table className="mt-1 min-w-full text-xs"><thead className="text-left text-slate-500"><tr><th className="py-1 pr-3">#</th><th className="pr-3">Solicitud</th><th className="pr-3">Tipo</th><th className="pr-3">OT</th><th className="pr-3">Ref.</th><th className="pr-3">Proveedor</th><th className="pr-3">Cliente</th><th className="pr-3">Origen</th><th className="pr-3">Destino</th><th className="pr-3 text-right">Km tramo</th><th className="pr-3">Fuente km</th><th className="pr-3">Odómetro / foto</th><th className="pr-3">Guía</th><th className="pr-3 text-right">Peso</th><th>Estado</th></tr></thead>
                      <tbody>{x.stops.map(s => <tr key={s.request_number + s.sequence} className="border-t border-slate-200"><td className="py-1 pr-3">{s.sequence}</td><td className="pr-3">{s.request_number}</td><td className="pr-3">{TYPE[s.type] || s.type}</td><td className="pr-3">{s.ot || '—'}</td><td className="pr-3">{s.ref_type && s.ref_number ? `${s.ref_type} ${s.ref_number}` : '—'}</td><td className="pr-3">{s.reference_supplier || '—'}</td><td className="pr-3">{s.client || '—'}</td><td className="pr-3">{s.origin || '—'}</td><td className="pr-3">{s.destination || '—'}</td>
                        <td className="pr-3 text-right">{s.km_leg != null ? formatKm(s.km_leg) : '—'}</td><td className={`pr-3 ${s.km_source === 'SIN_DATO' ? 'font-semibold text-red-700' : 'text-slate-600'}`}>{s.km_source === 'GPS_COMPLETO' ? 'GPS completo' : s.km_source === 'ODOMETRO' ? 'Odómetro' : s.km_source === 'GPS_PARCIAL' ? 'GPS parcial' : 'Sin dato'}</td><td className="pr-3">{s.odo_reading != null ? <>{formatKm(s.odo_reading)}{s.odo_photo && <button type="button" onClick={() => void openPhoto(s.odo_photo!)} className="ml-1 text-blue-700 underline">foto</button>}{s.odo_flag && <span className="ml-1 font-semibold text-amber-700">· revisar salto</span>}</> : '—'}</td><td className="pr-3">{s.guide || '—'}</td>
                        <td className="whitespace-nowrap pr-3 text-right">{s.kg != null ? `${Number(s.kg).toLocaleString('es-PE')} kg` : '—'}{s.kg_source === 'DECLARADO' && <span className="text-slate-500"> (decl.)</span>}</td><td>{s.status}</td></tr>)}</tbody></table>
                  </div>)}
                </td></tr>}
              </Fragment>
            })}
          </tbody>
        </table>
      </div>}

      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
          <h2 className="text-sm font-semibold text-slate-800">OT, OS, OC y RQ atendidas</h2>
          <div className="flex flex-wrap gap-1">{(['TODAS', 'OT', 'OS', 'OC', 'RQ'] as const).map(k => <button key={k} type="button" onClick={() => setRefKind(k)} aria-pressed={refKind === k}
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${refKind === k ? 'bg-[#002855] text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}>{k === 'TODAS' ? `Todas (${refs.length})` : `${k} (${refCount(k)})`}</button>)}</div>
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
              <td className="whitespace-nowrap px-3 py-2 text-right">{r.kg ? `${Math.round(r.kg).toLocaleString('es-PE')} kg` : '—'}</td>
            </tr>)}</tbody></table></div>}
      </div>
      <p className="text-xs text-slate-500">Peso: APT validado por la guía; si falta, el declarado en la solicitud (decl.). Las paradas muestran km GPS completos o, si falta señal, la diferencia de odómetro con foto. El cierre usa odómetro final para conciliar la ruta. Los costos se detallan por OT y solicitud; alertas señalan lecturas anómalas.</p>
    </>}
  </div>
}
