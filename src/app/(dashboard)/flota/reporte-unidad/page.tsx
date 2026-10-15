'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Download, Image as ImageIcon, Loader2, Search } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { exportAptXlsx } from '@/lib/apt/export'
import { receiptUrl } from '@/lib/caja'
import { formatKm } from '@/lib/odometer'

type Stop = { sequence: number; status: string; request_number: string; type: string; ot: string | null; client: string | null; destination: string | null
  km_leg: number | null; guide: string | null; kg: number | null; kg_source: 'APT' | 'DECLARADO' | null }
type Dispatch = { dispatch_number: string; status: string; driver: string | null; modalidad: string | null; departure: string; km_gps: number | null; stops: Stop[] }
type Reading = { kind: 'INICIO' | 'CIERRE'; odometer: number; at: string; photo: string; flag: string | null }
type Day = { date: string; drivers: string[] | null; checklists: number; operative: boolean | null; odo_start: number | null; odo_end: number | null
  end_source: 'CIERRE' | 'SIGUIENTE_INICIO' | null; km_odo: number | null; km_gps: number | null; routes: number; services: number; ots: number; clients: number
  tn: number | null; tn_apt: number | null; readings: Reading[]; dispatches: Dispatch[]; alerts: string[] }
type Report = { success: boolean; error?: string; plate: string; type: string | null; current_odometer: number | null; from: string; to: string
  totals: { days_active: number; routes: number; services: number; ots: number; km_odo: number; km_gps: number; days_with_odo: number; tn: number; tn_apt: number; checklists: number }
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

export default function ReporteUnidadPage() {
  const supabase = useMemo(() => createClient(), [])
  const [plates, setPlates] = useState<{ plate: string; type: string | null }[]>([])
  const [plate, setPlate] = useState('')
  const [from, setFrom] = useState(() => iso(new Date(Date.now() - 6 * 86400000)))
  const [to, setTo] = useState(() => iso(new Date()))
  const [report, setReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState<Record<string, boolean>>({})

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

  const openPhoto = async (path: string) => {
    const url = await receiptUrl(supabase, path)
    if (url) window.open(url, '_blank', 'noopener'); else toast.error('No tiene acceso a la foto')
  }

  const exportXlsx = () => {
    if (!report) return
    exportAptXlsx(`Reporte_unidad_${report.plate}_${report.from}_${report.to}`, {
      'Resumen diario': report.days.map(d => ({
        Fecha: d.date, Conductores: (d.drivers || []).join(', '), Checklists: d.checklists, 'Operativa': d.operative == null ? '' : d.operative ? 'Sí' : 'No',
        'Odómetro inicio': d.odo_start, 'Odómetro fin': d.odo_end, 'Fuente fin': d.end_source === 'SIGUIENTE_INICIO' ? 'Inicio del día siguiente' : d.end_source === 'CIERRE' ? 'Cierre de jornada' : '',
        'Km odómetro': d.km_odo, 'Km GPS': d.km_gps, Rutas: d.routes, Servicios: d.services, OT: d.ots, Clientes: d.clients, 'Toneladas': d.tn, 'Toneladas APT': d.tn_apt,
        Alertas: d.alerts.map(a => ALERTS[a]?.label || a).join(', '),
      })),
      Servicios: report.days.flatMap(d => d.dispatches.flatMap(x => x.stops.map(s => ({
        Fecha: d.date, Ruta: x.dispatch_number, Estado_ruta: x.status, Conductor: x.driver, 'Km GPS ruta': x.km_gps, Parada: s.sequence, Solicitud: s.request_number,
        Tipo: TYPE[s.type] || s.type, OT: s.ot, Cliente: s.client, Destino: s.destination, 'Km tramo': s.km_leg, Guía: s.guide, 'Peso kg': s.kg,
        'Fuente peso': s.kg_source === 'APT' ? 'APT validado' : s.kg_source === 'DECLARADO' ? 'Declarado en solicitud' : '', Estado: s.status,
      })))),
      'Lecturas odómetro': report.days.flatMap(d => d.readings.map(r => ({ Fecha: d.date, Tipo: r.kind === 'INICIO' ? 'Inicio (checklist)' : 'Cierre de jornada', Hora: fmtTime(r.at), Odómetro: r.odometer, Observación: r.flag || '' }))),
    })
  }

  const t = report?.totals
  const card = 'rounded-xl border border-slate-200 bg-white p-3'
  return <div className="space-y-4">
    <PageHeader title="Reporte por unidad" description="Qué hizo la unidad cada día: checklist, odómetro, km, rutas, OT, clientes y peso." actions={report && <button type="button" onClick={exportXlsx} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"><Download className="h-4 w-4" />Excel</button>} />
    <form onSubmit={e => { e.preventDefault(); void run(plate, from, to) }} className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3">
      <label className="text-xs font-medium text-slate-600">Unidad
        <select value={plate} onChange={e => setPlate(e.target.value)} className="mt-1 block min-w-40 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
          <option value="">Seleccione la placa</option>{plates.map(p => <option key={p.plate} value={p.plate}>{p.plate}{p.type ? ` · ${p.type}` : ''}</option>)}
        </select></label>
      <label className="text-xs font-medium text-slate-600">Desde<input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm" /></label>
      <label className="text-xs font-medium text-slate-600">Hasta<input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm" /></label>
      <button type="submit" disabled={!plate || loading} className="inline-flex items-center gap-1.5 rounded-lg bg-[#002855] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}Consultar</button>
      <p className="text-xs text-slate-500">Máximo 93 días. Km odómetro = cierre de jornada (o inicio del día siguiente) − inicio del checklist.</p>
    </form>

    {!report ? <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">Elija una unidad y el período para ver su operación diaria.</p> : <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        {[
          ['Días operando', t?.days_active], ['Rutas', t?.routes], ['Servicios', t?.services], ['OT atendidas', t?.ots],
          ['Km odómetro', `${formatKm(t?.km_odo)}`, `${t?.days_with_odo || 0} día(s) con lectura completa`], ['Km GPS', formatKm(t?.km_gps)],
          ['Peso transportado', tn(t?.tn), `APT validado: ${tn(t?.tn_apt)}`], ['Checklists', t?.checklists],
        ].map(([label, value, hint]) => <div key={String(label)} className={card}><p className="text-xs text-slate-500">{label}</p><p className="text-lg font-bold text-slate-900">{value ?? '—'}</p>{hint && <p className="text-[11px] text-slate-500">{hint}</p>}</div>)}
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr>
            <th className="px-3 py-2" /><th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Conductor(es)</th><th className="px-3 py-2">Checklist</th>
            <th className="px-3 py-2">Odómetro</th><th className="px-3 py-2 text-right">Km odóm.</th><th className="px-3 py-2 text-right">Km GPS</th>
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
                  <td className="px-3 py-2 text-right font-semibold">{d.km_odo != null ? formatKm(d.km_odo) : '—'}</td>
                  <td className="px-3 py-2 text-right">{d.km_gps != null ? formatKm(d.km_gps) : '—'}</td>
                  <td className="px-3 py-2 text-right">{d.routes || '—'}</td><td className="px-3 py-2 text-right">{d.services || '—'}</td><td className="px-3 py-2 text-right">{d.ots || '—'}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">{d.tn ? tn(d.tn) : '—'}</td>
                  <td className="px-3 py-2"><div className="flex flex-wrap gap-1">{d.alerts.map(a => <span key={a} className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${ALERTS[a]?.tone || 'bg-slate-100'}`}>{ALERTS[a]?.label || a}</span>)}</div></td>
                </tr>
                {isOpen && <tr><td colSpan={12} className="bg-slate-50 px-6 py-3">
                  {d.readings.length > 0 && <div className="mb-3 flex flex-wrap gap-2 text-xs">{d.readings.map((r, i) => <button key={i} type="button" onClick={() => void openPhoto(r.photo)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 hover:bg-slate-100">
                    <ImageIcon className="h-3.5 w-3.5" />{r.kind === 'INICIO' ? 'Inicio' : 'Cierre'} {fmtTime(r.at)} · {formatKm(r.odometer)}{r.flag && <b className="text-red-700"> · {r.flag === 'RETROCESO' ? 'retrocede' : 'salto'}</b>}</button>)}</div>}
                  {d.dispatches.length === 0 ? <p className="text-xs text-slate-500">Sin rutas este día.</p> : d.dispatches.map(x => <div key={x.dispatch_number} className="mb-3">
                    <p className="text-xs font-semibold text-slate-700">Ruta {x.dispatch_number} · {x.status} · {x.driver || '—'} · salida {fmtTime(x.departure)} · GPS {formatKm(x.km_gps)}</p>
                    <table className="mt-1 min-w-full text-xs"><thead className="text-left text-slate-500"><tr><th className="py-1 pr-3">#</th><th className="pr-3">Solicitud</th><th className="pr-3">Tipo</th><th className="pr-3">OT</th><th className="pr-3">Cliente</th><th className="pr-3">Destino</th><th className="pr-3 text-right">Km tramo</th><th className="pr-3">Guía</th><th className="pr-3 text-right">Peso</th><th>Estado</th></tr></thead>
                      <tbody>{x.stops.map(s => <tr key={s.request_number + s.sequence} className="border-t border-slate-200"><td className="py-1 pr-3">{s.sequence}</td><td className="pr-3">{s.request_number}</td><td className="pr-3">{TYPE[s.type] || s.type}</td><td className="pr-3">{s.ot || '—'}</td><td className="pr-3">{s.client || '—'}</td><td className="pr-3">{s.destination || '—'}</td>
                        <td className="pr-3 text-right">{s.km_leg != null ? formatKm(s.km_leg) : '—'}</td><td className="pr-3">{s.guide || '—'}</td>
                        <td className="whitespace-nowrap pr-3 text-right">{s.kg != null ? `${Number(s.kg).toLocaleString('es-PE')} kg` : '—'}{s.kg_source === 'DECLARADO' && <span className="text-slate-500"> (decl.)</span>}</td><td>{s.status}</td></tr>)}</tbody></table>
                  </div>)}
                </td></tr>}
              </Fragment>
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">Peso: APT validado por la guía; si falta, el declarado en la solicitud (decl.). Km GPS: lo registrado por el app en cada ruta. Las alertas señalan días a revisar (sin checklist u odómetro, km sin ruta, GPS incompleto u odómetro inconsistente).</p>
    </>}
  </div>
}
