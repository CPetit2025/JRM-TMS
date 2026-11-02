'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, CalendarDays, CheckCircle2, ChevronDown, ChevronRight, Clock3, Gauge, Loader2, MapPin, Package, RefreshCw, Route, Truck } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { receiptUrl } from '@/lib/caja'
import { buildDispatchDashboard, trackingRange, type DashboardRoute, type DashboardStop, type PortalStop, type ReportDay, type TrackingMode, type UnitReport } from '@/lib/dispatch-tracking'
import { openPortalDocument, type PortalAccess } from '@/lib/tracking-portal'

type Props = { site: string; rows: PortalStop[]; anchor: string; onAnchor: (day: string) => void; refreshKey: number; onRefresh: () => void }
type Plate = { plate: string; type: string | null; status: string | null; site_id: string }
type UnitResponse = { success?: boolean; error?: string; plate: string; days: ReportDay[] }

const todayLima = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const shortDate = (date: string) => new Date(`${date}T12:00:00-05:00`).toLocaleDateString('es-PE', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'America/Lima' })
const timeLima = (value: string | null | undefined) => value ? new Date(value).toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: true }) : '—'
const km = (value: number | null | undefined) => value == null || !Number.isFinite(Number(value)) ? '—' : `${Number(value).toLocaleString('es-PE', { maximumFractionDigits: 1 })} km`
const count = (value: number) => value.toLocaleString('es-PE')
const cost = (value: number | null | undefined) => `S/ ${Number(value || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const routeStatus = (status: string) => status === 'CIERRE_OPERATIVO' ? 'Cierre operativo' : status.replaceAll('_', ' ')

const alertMeta: Record<string, { label: string; cls: string }> = {
  GPS_INCOMPLETO: { label: 'GPS incompleto', cls: 'border-amber-200 bg-amber-50 text-amber-800' },
  GPS_PARCIAL: { label: 'GPS parcial', cls: 'border-amber-200 bg-amber-50 text-amber-800' },
  SIN_ODOMETRO: { label: 'Sin odómetro', cls: 'border-rose-200 bg-rose-50 text-rose-800' },
  SIN_CIERRE: { label: 'Sin cierre', cls: 'border-slate-200 bg-slate-100 text-slate-700' },
  SIN_CHECKLIST: { label: 'Checklist pendiente', cls: 'border-amber-200 bg-amber-50 text-amber-800' },
  KM_SIN_RUTA: { label: 'Km sin ruta', cls: 'border-amber-200 bg-amber-50 text-amber-800' },
  EVIDENCIA_INCOMPLETA: { label: 'Evidencia incompleta', cls: 'border-rose-200 bg-rose-50 text-rose-800' },
  ODOMETRO_RETROCEDE: { label: 'Odómetro inconsistente', cls: 'border-rose-200 bg-rose-50 text-rose-800' },
  ODOMETRO_SALTO: { label: 'Salto de odómetro', cls: 'border-rose-200 bg-rose-50 text-rose-800' },
  SALTO: { label: 'Lectura atípica', cls: 'border-rose-200 bg-rose-50 text-rose-800' },
}

const stateTone = (route: DashboardRoute, stops: DashboardStop[]) => {
  const states = stops.map(stop => (stop.portal?.state || stop.status || '').toUpperCase())
  const routeState = route.status.toUpperCase()
  if (states.length && states.every(state => ['CANCELADO', 'ANULADO', 'ANULADA'].includes(state)) || routeState === 'CANCELADO') return { label: 'Cancelado', cls: 'border-slate-200 bg-slate-100 text-slate-700' }
  if (states.length && states.every(state => ['ENTREGADO', 'LIQUIDADO', 'CERRADO', 'COMPLETADO'].includes(state))) return { label: 'Entregado', cls: 'border-emerald-200 bg-emerald-50 text-emerald-800' }
  if (['EN RUTA', 'EN_CURSO', 'EN_DESTINO', 'RETORNO'].includes(routeState) || states.some(state => ['EN RUTA', 'EN_CURSO', 'EN_DESTINO'].includes(state))) return { label: 'En proceso', cls: 'border-amber-200 bg-amber-50 text-amber-900' }
  if (routeState === 'CIERRE_OPERATIVO') return { label: 'Cierre operativo', cls: 'border-amber-200 bg-amber-50 text-amber-900' }
  return { label: 'Programado', cls: 'border-blue-200 bg-blue-50 text-blue-800' }
}

function StatusTag({ label, cls }: { label: string; cls: string }) {
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold ${cls}`}><span className="h-2 w-2 rounded-full bg-current" />{label}</span>
}

function AlertTags({ alerts }: { alerts: Set<string> }) {
  if (!alerts.size) return <span className="text-xs text-slate-400">Sin alertas</span>
  return <div className="flex flex-wrap gap-1">{[...alerts].map(key => {
    const meta = alertMeta[key] || { label: key.replaceAll('_', ' '), cls: 'border-slate-200 bg-slate-100 text-slate-700' }
    return <span key={key} className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta.cls}`}><AlertTriangle className="h-3 w-3" />{meta.label}</span>
  })}</div>
}

function Kpi({ icon: Icon, label, value, note, accent = 'blue', percent }: { icon: typeof Truck; label: string; value: string; note?: string; accent?: string; percent?: number }) {
  const palette: Record<string, string> = { blue: 'text-sky-700 bg-sky-50', green: 'text-emerald-700 bg-emerald-50', amber: 'text-amber-700 bg-amber-50' }
  const color = palette[accent] || palette.blue
  return <article className="flex min-h-[92px] items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-3 shadow-sm sm:px-4">
    {percent == null ? <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-full ${color}`}><Icon className="h-5 w-5" /></span>
      : <span className="relative grid h-12 w-12 shrink-0 place-items-center rounded-full" style={{ background: `conic-gradient(${accent === 'green' ? '#16a34a' : '#f59e0b'} ${Math.min(100, Math.max(0, percent))}%, #e2e8f0 0)` }}><span className="grid h-8 w-8 place-items-center rounded-full bg-white text-[10px] font-bold text-slate-600">{Math.round(percent)}%</span></span>}
    <div className="min-w-0"><p className="text-xs font-medium text-slate-500">{label}</p><p className="truncate text-2xl font-black leading-tight tabular-nums text-[#10294d]">{value}</p>{note && <p className="truncate text-xs text-slate-500">{note}</p>}</div>
  </article>
}

function EvidenceButton({ path, label, onOpen }: { path: string | null | undefined; label: string; onOpen: (path: string) => void }) {
  return path ? <button type="button" onClick={() => onOpen(path)} className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-slate-300 bg-white px-2 text-xs font-semibold text-[#002855] hover:bg-blue-50"><MapPin className="h-3.5 w-3.5" />{label}</button>
    : <span className="text-xs text-slate-400">Sin foto</span>
}

function DocumentButtons({ row, access }: { row: PortalStop; access: PortalAccess }) {
  const [busy, setBusy] = useState(false)
  const open = async (target: Parameters<typeof openPortalDocument>[1]) => {
    setBusy(true)
    try { await openPortalDocument(access, target) } catch (error) { toast.error(error instanceof Error ? error.message : 'Documento no disponible') } finally { setBusy(false) }
  }
  const signed = Math.min(row.signed_photos || 0, 5), packing = Math.min(row.packing_photos || 0, 5)
  return <div className="flex flex-wrap items-center gap-1">
    {(row.documents || []).map(doc => <button key={doc.id} type="button" disabled={busy} onClick={() => void open({ kind: 'DOC', id: doc.id })} className="rounded-md border border-slate-300 px-2 py-1 text-[11px] font-semibold text-[#002855] disabled:opacity-50">{doc.type === 'PACKING_LIST' ? 'Packing List' : 'Guía'}{doc.number ? ` ${doc.number}` : ''}</button>)}
    {Array.from({ length: signed }, (_, index) => <button key={`guide-${row.request_id}-${index}`} type="button" disabled={busy} onClick={() => void open({ kind: 'FIRMA', dispatchId: row.dispatch_id, requestId: row.request_id, index: index + 1 })} className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-800 disabled:opacity-50">Guía {row.guide_number || ''}</button>)}
    {Array.from({ length: packing }, (_, index) => <button key={`packing-${row.request_id}-${index}`} type="button" disabled={busy} onClick={() => void open({ kind: 'PACKING', dispatchId: row.dispatch_id, requestId: row.request_id, index: index + 1 })} className="rounded-md border border-slate-300 px-2 py-1 text-[11px] font-semibold text-[#002855] disabled:opacity-50">Packing {index + 1}</button>)}
    {!row.documents?.length && !signed && !packing && <span className="text-xs text-slate-400">{row.guide_number || 'Sin guía'}</span>}
  </div>
}

function ServiceDetail({ route, access, onPhoto }: { route: DashboardRoute; access: PortalAccess; onPhoto: (path: string) => void }) {
  const stops = route.stops
  return <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
    <div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[1380px] table-fixed text-left text-xs">
      <thead className="bg-slate-100 text-[11px] font-bold text-slate-700"><tr>
        {['N.º', 'Solicitud', 'Tipo', 'OT', 'Referencia / proveedor', 'Cliente', 'Origen', 'Destino', 'Km tramo', 'Fuente km', 'Odómetro / foto', 'Guía', 'Peso', 'Estado'].map((title, index) => <th key={title} className={`px-2 py-2 ${[0, 8, 12].includes(index) ? 'text-right' : ''}`} style={{ width: [42, 100, 82, 80, 160, 150, 170, 190, 85, 95, 145, 130, 85, 125][index] }}>{title}</th>)}
      </tr></thead>
      <tbody className="divide-y divide-slate-100">{stops.map((stop, index) => {
        const supplier = stop.reference_supplier || stop.portal?.supplier_name
        const ref = stop.ref_type && stop.ref_number ? `${stop.ref_type} ${stop.ref_number}` : stop.portal?.purchase_order || '—'
        const source = stop.km_source === 'ODOMETRO' ? 'Odómetro' : stop.km_source === 'GPS_COMPLETO' ? 'GPS completo' : stop.km_source === 'GPS_PARCIAL' ? 'GPS parcial' : 'Sin dato'
        const state = stateTone(route, [stop])
        return <tr key={`${route.key}/${stop.request_number}`} className="align-top hover:bg-slate-50">
          <td className="px-2 py-2 text-right tabular-nums">{stop.portal?.sequence_order || stop.sequence || index + 1}</td>
          <td className="px-2 py-2 font-semibold text-[#002855]">{stop.request_number}</td>
          <td className="px-2 py-2">{stop.type || stop.portal?.request_type || '—'}</td>
          <td className="px-2 py-2">{stop.ot || stop.portal?.ot_code || '—'}</td>
          <td className="px-2 py-2"><span className="block font-medium">{ref}</span><span className="block truncate text-slate-500" title={supplier || undefined}>{supplier || 'Proveedor —'}</span></td>
          <td className="px-2 py-2"><span className="line-clamp-2" title={stop.client || stop.portal?.client_name || undefined}>{stop.client || stop.portal?.client_name || '—'}</span></td>
          <td className="px-2 py-2"><details><summary className="cursor-pointer line-clamp-2" title={stop.origin || stop.portal?.pickup_address || undefined}>{stop.origin || stop.portal?.pickup_address || '—'}</summary><p className="max-w-56 whitespace-normal pt-1 text-slate-600">{stop.origin || stop.portal?.pickup_address || '—'}</p></details></td>
          <td className="px-2 py-2"><details><summary className="cursor-pointer line-clamp-2" title={stop.destination || stop.portal?.delivery_address || undefined}>{stop.destination || stop.portal?.delivery_address || '—'}</summary><p className="max-w-56 whitespace-normal pt-1 text-slate-600">{stop.destination || stop.portal?.delivery_address || '—'}</p></details></td>
          <td className="px-2 py-2 text-right tabular-nums">{km(stop.km_leg)}</td><td className="px-2 py-2">{source}</td>
          <td className="px-2 py-2"><span className="block tabular-nums">{stop.odo_reading == null ? '—' : Number(stop.odo_reading).toLocaleString('es-PE')}</span><EvidenceButton path={stop.odo_photo} label="Foto odómetro" onOpen={onPhoto} /></td>
          <td className="px-2 py-2">{stop.portal ? <DocumentButtons row={stop.portal} access={access} /> : stop.guide || '—'}</td>
          <td className="px-2 py-2 text-right tabular-nums">{stop.kg == null ? '—' : `${(Number(stop.kg) / 1000).toLocaleString('es-PE', { maximumFractionDigits: 2 })} t`}</td>
          <td className="px-2 py-2"><StatusTag label={state.label} cls={state.cls} /></td>
        </tr>
      })}{!stops.length && <tr><td colSpan={14} className="p-5 text-center text-slate-500">La ruta no tiene servicios asociados.</td></tr>}</tbody>
    </table></div>
    <div className="divide-y md:hidden">{stops.map((stop, index) => {
      const state = stateTone(route, [stop])
      return <article key={`${route.key}/mobile/${stop.request_number}`} className="space-y-2 p-3 text-xs">
        <div className="flex items-center justify-between gap-2"><strong className="text-sm text-[#002855]">{index + 1}. {stop.request_number}</strong><StatusTag label={state.label} cls={state.cls} /></div>
        <p><b>OT:</b> {stop.ot || stop.portal?.ot_code || '—'} · <b>Tipo:</b> {stop.type || stop.portal?.request_type || '—'}</p>
        <p><b>Ref.:</b> {stop.ref_type && stop.ref_number ? `${stop.ref_type} ${stop.ref_number}` : stop.portal?.purchase_order || '—'} · <b>Proveedor:</b> {stop.reference_supplier || stop.portal?.supplier_name || '—'}</p>
        <p><b>Cliente:</b> {stop.client || stop.portal?.client_name || '—'}</p>
        <p><b>Origen:</b> {stop.origin || stop.portal?.pickup_address || '—'}</p><p><b>Destino:</b> {stop.destination || stop.portal?.delivery_address || '—'}</p>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-slate-600"><span>Km {km(stop.km_leg)}</span><span>Fuente {stop.km_source || 'Sin dato'}</span><span>Odómetro {stop.odo_reading == null ? '—' : Number(stop.odo_reading).toLocaleString('es-PE')}</span><span>Peso {stop.kg == null ? '—' : `${(Number(stop.kg) / 1000).toLocaleString('es-PE')} t`}</span></div>
        <div className="flex flex-wrap items-center gap-2">{stop.odo_photo && <EvidenceButton path={stop.odo_photo} label="Foto odómetro" onOpen={onPhoto} />}{stop.portal && <DocumentButtons row={stop.portal} access={access} />}</div>
      </article>
    })}{!stops.length && <p className="p-5 text-center text-slate-500">La ruta no tiene servicios asociados.</p>}</div>
  </div>
}

function RouteDetails({ route, site, onPhoto }: { route: DashboardRoute; site: string; onPhoto: (path: string) => void }) {
  const access: PortalAccess = { site }
  const kmSource = route.km_real_source === 'ODOMETRO' ? 'Odómetro' : route.km_real_source === 'GPS' ? 'GPS' : 'Sin dato'
  const readings = route.reportDay?.readings || []
  const startEvidence = readings.find(reading => reading.kind === 'INICIO' && (route.odo_start == null || Number(reading.odometer) === Number(route.odo_start)))
  return <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-2 sm:p-3">
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs">
      <span className="inline-flex items-center gap-1.5 font-bold text-[#10294d]"><Route className="h-4 w-4 text-sky-700" />Ruta {route.dispatch_number}</span>
      <span className="rounded-full bg-slate-100 px-2 py-1 font-semibold">{routeStatus(route.status || 'PROGRAMADO')}</span>
      <span><b>Placa:</b> {route.plate || '—'}</span>
      <span><b>Salida:</b> {timeLima(route.departure)}</span>
      <span><b>Cierre:</b> {timeLima(route.closed_at)}</span>
      <span><b>GPS:</b> {km(route.km_gps)}</span>
      <span><b>Km ruta:</b> {km(route.km_real)} · {kmSource}</span>
      <span><b>Costos:</b> {cost(route.cost_applied)} aplicado</span>
      {(route.cost_pending || 0) > 0 && <span className="text-amber-800"><b>Pendiente:</b> {cost(route.cost_pending)}</span>}
      <span className="inline-flex items-center gap-1.5"><b>Odómetro:</b> {route.odo_start == null ? '—' : Number(route.odo_start).toLocaleString('es-PE')} → {route.odo_end == null ? '—' : Number(route.odo_end).toLocaleString('es-PE')}</span>
      {startEvidence?.photo && <EvidenceButton path={startEvidence.photo} label="Foto inicio" onOpen={onPhoto} />}
      {route.odo_end_photo && <EvidenceButton path={route.odo_end_photo} label="Foto cierre" onOpen={onPhoto} />}
    </div>
    <ServiceDetail route={route} access={access} onPhoto={onPhoto} />
  </div>
}

function GroupDetails({ group, site, onPhoto }: { group: ReturnType<typeof buildDispatchDashboard>['groups'][number]; site: string; onPhoto: (path: string) => void }) {
  if (!group.routes.length) return <div className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">No hubo ruta. Se conserva el checklist registrado para este conductor y fecha.</div>
  return <div className="space-y-2">{group.routes.map(route => <RouteDetails key={route.key} route={route} site={site} onPhoto={onPhoto} />)}</div>
}

export function DispatchTrackingDashboard({ site, rows, anchor, onAnchor, refreshKey, onRefresh }: Props) {
  const supabase = useMemo(() => createClient(), [])
  const [mode, setMode] = useState<TrackingMode>('DIA')
  const [reports, setReports] = useState<UnitReport[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [loadedAt, setLoadedAt] = useState<string | null>(null)
  const range = useMemo(() => trackingRange(mode, anchor), [mode, anchor])

  useEffect(() => {
    let alive = true
    const timer = window.setTimeout(() => { if (alive) { setLoading(true); setError('') } }, 0)
    const load = async () => {
      try {
        setLoading(true)
        setError('')
        const { data: plateData, error: plateError } = await supabase.rpc('unit_report_plates')
        if (plateError) throw plateError
        const list = ((plateData || []) as Plate[]).filter(item => item.site_id === site)
        if (!alive) return
        const results: UnitReport[] = []
        const failures: string[] = []
        for (let index = 0; index < list.length; index += 4) {
          const batch = list.slice(index, index + 4)
          const reportsForBatch = await Promise.all(batch.map(async unit => {
            const { data, error: reportError } = await supabase.rpc('unit_daily_report', { p_plate: unit.plate, p_from: range.from, p_to: range.to })
            if (reportError || !data?.success) { failures.push(`${unit.plate}: ${data?.error || reportError?.message || 'sin reporte'}`); return null }
            return data as UnitResponse
          }))
          if (!alive) return
          results.push(...reportsForBatch.filter((result): result is UnitResponse => result != null).map(result => ({ plate: result.plate, days: result.days || [] })))
        }
        if (!alive) return
        setReports(results)
        setError(failures.length ? `No se pudo cargar el odómetro de ${failures.length} unidad(es). Los despachos del seguimiento se mantienen visibles.` : '')
        setLoadedAt(new Date().toISOString()); setOpen({})
      } catch (cause) {
        if (!alive) return
        setReports([]); setError(cause instanceof Error ? cause.message : 'No se pudo cargar el reporte de despachos')
      } finally { if (alive) setLoading(false) }
    }
    void load()
    return () => { alive = false; window.clearTimeout(timer) }
  }, [supabase, site, range, refreshKey])

  const dashboard = useMemo(() => buildDispatchDashboard(rows, reports, range), [rows, reports, range])
  const deliveredPercent = dashboard.totals.services ? dashboard.totals.delivered / dashboard.totals.services * 100 : 0
  const progressPercent = dashboard.totals.services ? dashboard.totals.inProgress / dashboard.totals.services * 100 : 0

  const openPhoto = async (path: string) => {
    const url = await receiptUrl(supabase, path)
    if (url) window.open(url, '_blank', 'noopener'); else toast.error('No se pudo abrir la evidencia o no tiene acceso')
  }
  const changeDate = (value: string) => { if (value) onAnchor(mode === 'MES' ? `${value}-01` : value) }
  const shiftRange = (direction: number) => {
    if (mode === 'DIA') { const date = new Date(`${anchor}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + direction); onAnchor(date.toISOString().slice(0, 10)); return }
    if (mode === 'SEMANA') { const date = new Date(`${anchor}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + 7 * direction); onAnchor(date.toISOString().slice(0, 10)); return }
    const [year, month] = anchor.slice(0, 7).split('-').map(Number)
    onAnchor(new Date(Date.UTC(year, month - 1 + direction, 1, 12)).toISOString().slice(0, 10))
  }
  const allAlerts = dashboard.groups.reduce((sum, group) => sum + group.alerts.size, 0)
  const lastUpdate = loadedAt ? timeLima(loadedAt) : '—'

  return <section className="space-y-3" aria-label="Seguimiento consolidado de despachos">
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-2.5 shadow-sm sm:px-3">
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <CalendarDays className="mr-1 h-4 w-4 text-[#0d5480]" />
        <span className="font-semibold text-slate-600">Ver por:</span>
        {([['DIA', 'Día'], ['SEMANA', 'Semana'], ['MES', 'Mes']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)} className={`min-h-9 rounded-lg px-3 text-sm font-semibold ${mode === value ? 'bg-[#12527d] text-white shadow-sm' : 'text-slate-700 hover:bg-slate-100'}`}>{label}</button>)}
        <button type="button" aria-label="Período anterior" onClick={() => shiftRange(-1)} className="ml-2 grid h-9 w-9 place-items-center rounded-lg border text-lg text-slate-700">‹</button>
        {mode === 'MES' ? <input aria-label="Mes del seguimiento" type="month" value={anchor.slice(0, 7)} onChange={e => changeDate(e.target.value)} className="h-9 rounded-lg border border-slate-300 px-2 text-sm" />
          : <input aria-label="Fecha del seguimiento" type="date" value={anchor} onChange={e => changeDate(e.target.value)} className="h-9 rounded-lg border border-slate-300 px-2 text-sm" />}
        <button type="button" aria-label="Período siguiente" onClick={() => shiftRange(1)} className="grid h-9 w-9 place-items-center rounded-lg border text-lg text-slate-700">›</button>
        <button type="button" onClick={() => onAnchor(todayLima())} className="h-9 rounded-lg border px-2.5 text-xs font-semibold text-[#002855]">Hoy</button>
      </div>
      <div className="flex items-center gap-2 text-xs text-slate-500"><span>Actualizado {lastUpdate} · hora Lima</span><button type="button" onClick={() => { setOpen({}); onRefresh() }} className="inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 font-semibold text-[#002855]"><RefreshCw className="h-3.5 w-3.5" />Actualizar</button></div>
    </div>

    {error && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{error}</p>}
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
      <Kpi icon={Truck} label="Despachos" value={count(dashboard.totals.dispatches)} note="Rutas registradas" />
      <Kpi icon={Route} label="Rutas" value={count(dashboard.totals.routes)} note={`${dashboard.groups.length} fecha(s) / conductor`} />
      <Kpi icon={Package} label="Servicios" value={count(dashboard.totals.services)} note="Solicitudes únicas" />
      <Kpi icon={Gauge} label="Km recorridos" value={km(dashboard.totals.kmOdo)} note="Odómetros válidos · GPS aparte" />
      <Kpi icon={CheckCircle2} label="Entregados" value={count(dashboard.totals.delivered)} note={`${Math.round(deliveredPercent)} % de servicios`} accent="green" percent={deliveredPercent} />
      <Kpi icon={Activity} label="En proceso" value={count(dashboard.totals.inProgress)} note={`${Math.round(progressPercent)} % de servicios`} accent="amber" percent={progressPercent} />
    </div>

    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
      <span className="font-semibold text-slate-700">{shortDate(range.from)}{range.from !== range.to ? ` — ${shortDate(range.to)}` : ''} · {dashboard.groups.length} fila(s) de fecha y conductor · {allAlerts} alerta(s)</span>
      <span className="flex flex-wrap items-center gap-2 text-slate-600"><span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-blue-600" />Programado</span><span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-amber-500" />En proceso</span><span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-emerald-600" />Entregado</span><span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-full bg-slate-400" />Cancelado</span></span>
    </div>

    {loading && <div className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-8 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Cargando odómetros, rutas y costos del período…</div>}
    {!loading && !dashboard.groups.length && <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">No hay despachos ni checklists registrados para este período.</div>}

    {!!dashboard.groups.length && <>
      <div className="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm lg:block">
        <table className="w-full min-w-[1430px] border-collapse text-left text-xs">
          <thead className="bg-[#14547f] text-white"><tr>{['', 'Fecha', 'Conductor', 'Checklist', 'Odómetro', 'Km recorridos', 'Km GPS', 'Rutas', 'Servicios', 'OT', 'Peso (TN)', 'Costos', 'Alerta / Estado'].map((title, index) => <th key={title || 'expand'} className={`px-2.5 py-2.5 ${[5, 6, 7, 8, 10, 11].includes(index) ? 'text-right' : ''}`}>{title}</th>)}</tr></thead>
          <tbody className="divide-y divide-slate-100">{dashboard.groups.map(group => {
            const expanded = !!open[group.key]
            const summary = group.routes.length ? stateTone(group.routes[0], group.stops) : group.checklists ? { label: 'Sin ruta', cls: 'border-slate-200 bg-slate-100 text-slate-700' } : { label: 'Programado', cls: 'border-blue-200 bg-blue-50 text-blue-800' }
            return <Fragment key={group.key}><tr className="bg-sky-50/70 hover:bg-sky-50">
              <td className="w-8 px-2 py-2"><button type="button" aria-label={`${expanded ? 'Ocultar' : 'Mostrar'} rutas de ${group.driver}`} aria-expanded={expanded} onClick={() => setOpen(previous => ({ ...previous, [group.key]: !previous[group.key] }))} className="grid h-8 w-8 place-items-center rounded-md hover:bg-white">{expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button></td>
              <td className="whitespace-nowrap px-2.5 py-2 font-semibold">{shortDate(group.date)}</td><td className="min-w-36 px-2.5 py-2 font-medium text-[#10294d]">{group.driver}</td>
              <td className="px-2.5 py-2">{group.checklists ? <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 ${group.operative === false ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}><CheckCircle2 className="h-3.5 w-3.5" />{group.checklists} {group.operative === false ? 'observada' : 'operativa'}</span> : <span className="text-slate-400">Pendiente</span>}</td>
              <td className="max-w-56 px-2.5 py-2 tabular-nums" title={group.odometerLabel}>{group.odometerLabel}</td>
              <td className="px-2.5 py-2 text-right font-semibold tabular-nums">{km(group.kmOdo)}</td><td className="px-2.5 py-2 text-right tabular-nums">{km(group.kmGps)}</td>
              <td className="px-2.5 py-2 text-right tabular-nums">{group.routes.length}</td><td className="px-2.5 py-2 text-right tabular-nums">{group.serviceCount}</td>
              <td className="max-w-44 px-2.5 py-2"><span className="line-clamp-2" title={group.ots.join(' · ')}>{group.ots.join(' · ') || '—'}</span></td>
              <td className="px-2.5 py-2 text-right tabular-nums">{group.weightTn == null ? '—' : group.weightTn.toLocaleString('es-PE', { maximumFractionDigits: 2 })}</td>
              <td className="px-2.5 py-2 text-right tabular-nums">{cost(group.costsApplied)}{group.costsPending > 0 && <span className="block text-amber-800">+ {cost(group.costsPending)} pend.</span>}</td>
              <td className="min-w-60 px-2.5 py-2"><div className="space-y-1"><StatusTag label={summary.label} cls={summary.cls} /><AlertTags alerts={group.alerts} /></div></td>
            </tr>{expanded && <tr className="bg-slate-50"><td colSpan={13} className="px-3 py-2"><GroupDetails group={group} site={site} onPhoto={path => void openPhoto(path)} /></td></tr>}</Fragment>
          })}</tbody>
        </table>
      </div>

      <div className="space-y-2 lg:hidden">{dashboard.groups.map(group => {
        const expanded = !!open[group.key]
        const status = group.routes.length ? stateTone(group.routes[0], group.stops) : { label: group.checklists ? 'Sin ruta' : 'Programado', cls: 'border-slate-200 bg-slate-100 text-slate-700' }
        return <article key={group.key} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <button type="button" aria-expanded={expanded} onClick={() => setOpen(previous => ({ ...previous, [group.key]: !previous[group.key] }))} className="flex w-full items-start gap-2 bg-sky-50/70 p-3 text-left">
            <span className="mt-0.5 text-slate-600">{expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</span><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center justify-between gap-2"><b className="text-sm text-[#10294d]">{group.driver}</b><StatusTag label={status.label} cls={status.cls} /></span><span className="mt-1 block text-xs text-slate-600">{shortDate(group.date)} · {group.routes.length} ruta(s) · {group.serviceCount} servicio(s)</span></span>
          </button>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 p-3 text-xs"><span><b>Checklist:</b> {group.checklists || 'Pendiente'}</span><span><b>Odómetro:</b> {group.odometerLabel}</span><span><b>Km recorridos:</b> {km(group.kmOdo)}</span><span><b>Km GPS:</b> {km(group.kmGps)}</span><span><b>OT:</b> {group.ots.join(', ') || '—'}</span><span><b>Peso:</b> {group.weightTn == null ? '—' : `${group.weightTn.toLocaleString('es-PE', { maximumFractionDigits: 2 })} t`}</span><span><b>Costos aplicados:</b> {cost(group.costsApplied)}</span><span><b>Pendientes:</b> {cost(group.costsPending)}</span><div className="col-span-2"><AlertTags alerts={group.alerts} /></div></div>
          {expanded && <div className="border-t bg-slate-50 p-2"><GroupDetails group={group} site={site} onPhoto={path => void openPhoto(path)} /></div>}
        </article>
      })}</div>
    </>}
    <p className="flex items-center gap-1.5 text-[11px] text-slate-500"><Clock3 className="h-3 w-3" />Los kilómetros recorridos usan lecturas válidas de odómetro; GPS se muestra por separado. Los días con checklist y sin ruta siguen visibles. {loading && <Loader2 className="h-3 w-3 animate-spin" />}</p>
  </section>
}
