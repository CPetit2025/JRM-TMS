'use client'

import { Suspense, use, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { AlertTriangle, ArrowLeft, ChevronLeft, ChevronRight, CircleCheck, Coins, FileText, Gauge, Loader2, Navigation, Scale, Truck, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { receiptUrl } from '@/lib/caja'
import { formatKm } from '@/lib/odometer'
import { ALERTS, STATUS, applyFilters, filtersFrom, fmtDate, fmtTime, iso, soles, tn, type Fleet, type JornadaRow } from '@/lib/jornada'
import { CostPanel, InfoPanel, KmPanel, OperationPanel, RouteSources, StatusBadge, Timeline } from '@/components/flota/jornada/JornadaPanels'
import { JornadaRoutes } from '@/components/flota/jornada/JornadaRoutes'

// Detalle de Jornada de Transporte (Vista 2, docs/control-jornada-plan.md): una unidad en un día, con los mismos paneles
// y datos que la tabla (fleet_workdays). Anterior / siguiente recorren la lista de la tabla con sus filtros y orden.

export default function JornadaDetailPage({ params }: { params: Promise<{ plate: string; date: string }> }) {
  const { plate, date } = use(params)
  return <Suspense fallback={null}><JornadaDetail plate={decodeURIComponent(plate)} date={date} /></Suspense>
}

function JornadaDetail({ plate, date }: { plate: string; date: string }) {
  const supabase = useMemo(() => createClient(), [])
  const params = useSearchParams()
  const today = iso(new Date())
  const from = params.get('desde') || `${today.slice(0, 7)}-01`, to = params.get('hasta') || today
  const inPeriod = date >= from && date <= to && (Date.parse(to) - Date.parse(from)) / 864e5 <= 92
  const [fleet, setFleet] = useState<Fleet | null>(null)
  const [tab, setTab] = useState<'recorrido' | 'gps' | 'observaciones'>('recorrido')
  useEffect(() => {
    let alive = true
    // Con el período de la tabla (para navegar); fuera de él, solo esta jornada
    void supabase.rpc('fleet_workdays', inPeriod ? { p_from: from, p_to: to } : { p_from: date, p_to: date, p_plates: [plate] }).then(({ data, error }) => {
      if (!alive) return
      if (error || !data?.success) { toast.error(data?.error || error?.message || 'No se pudo cargar la jornada'); setFleet({ success: false, savings_available: false, units: [], rows: [] }); return }
      setFleet(data as Fleet)
    })
    return () => { alive = false }
  }, [supabase, from, to, inPeriod, date, plate])

  const r = fleet?.rows.find(x => x.plate === plate && x.date === date)
  const list = useMemo(() => fleet && inPeriod ? applyFilters([...fleet.rows], filtersFrom(params)) : [], [fleet, inPeriod, params])
  const i = r ? list.findIndex(x => x.plate === r.plate && x.date === r.date) : -1
  const qs = params.toString()
  const href = (x: JornadaRow) => `/flota/reporte-unidad/${encodeURIComponent(x.plate)}/${x.date}${qs ? `?${qs}` : ''}`
  const unit = fleet?.units.find(u => u.plate === plate)
  const openPhoto = async (p: string) => { const url = await receiptUrl(supabase, p); if (url) window.open(url, '_blank', 'noopener'); else toast.error('No tiene acceso a la foto') }

  if (!fleet) return <p className="flex items-center justify-center gap-2 p-10 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Cargando jornada…</p>
  if (!r) return <div className="space-y-3 p-4"><Link href={`/flota/reporte-unidad${qs ? `?${qs}` : ''}`} className="inline-flex items-center gap-1 text-sm font-semibold text-[#002855]"><ArrowLeft className="h-4 w-4" />Volver a la tabla</Link>
    <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">No se encontró la jornada de {plate} del {date} o no tiene acceso a esa unidad.</p></div>

  const kpis: Array<[string, React.ReactNode, React.ReactNode]> = [
    ['Estado', r.status ? STATUS[r.status].label : '—', <CircleCheck key="i" className="h-5 w-5" />],
    ['Rutas', r.routes || '—', <Navigation key="i" className="h-5 w-5" />],
    ['Ton transportada', r.tn ? tn(r.tn) : '—', <Truck key="i" className="h-5 w-5" />],
    ['Toneladas APT', r.tn_apt ? tn(r.tn_apt) : '—', <Scale key="i" className="h-5 w-5" />],
    ['Km recorrido', r.km_odo != null ? formatKm(r.km_odo) : '—', <Gauge key="i" className="h-5 w-5" />],
    ['Ahorro', r.saving?.valued ? `S/ ${soles(r.saving.saving)}` : r.saving?.pending ? 'Pendiente' : '—', <Coins key="i" className="h-5 w-5" />],
  ]
  const box = 'rounded-xl border border-slate-200 bg-white p-3'

  return <div className="min-w-0 space-y-3">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <Link href={`/flota/reporte-unidad${qs ? `?${qs}` : ''}`} aria-label="Volver a la tabla" className="grid h-10 w-10 place-items-center rounded-lg border border-slate-300 bg-white text-[#002855]"><ArrowLeft className="h-5 w-5" /></Link>
        <div><h1 className="text-xl font-bold text-[#002855]">Detalle de Jornada de Transporte</h1>
          <p className="text-sm text-slate-600">{fmtDate(r.date)} · {r.plate}{r.unit_type ? ` · ${r.unit_type}` : ''} · {(r.drivers || []).join(', ') || 'sin conductor registrado'}</p></div>
      </div>
      <div className="flex items-center gap-2"><StatusBadge status={r.status} />
        {i > 0 ? <Link href={href(list[i - 1])} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold"><ChevronLeft className="h-4 w-4" />Anterior</Link>
          : <span className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-400"><ChevronLeft className="h-4 w-4" />Anterior</span>}
        {i >= 0 && i < list.length - 1 ? <Link href={href(list[i + 1])} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold">Siguiente<ChevronRight className="h-4 w-4" /></Link>
          : <span className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-400">Siguiente<ChevronRight className="h-4 w-4" /></span>}
      </div>
    </header>
    {i >= 0 && <p className="text-xs text-slate-500">Jornada {i + 1} de {list.length} según los filtros y el orden de la tabla.</p>}

    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">{kpis.map(([label, value, icon]) => <div key={label} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-slate-100 text-[#002855]">{icon}</span>
      <span><span className="block text-xs font-semibold text-slate-600">{label}</span><span className={`block text-lg font-bold ${label === 'Ahorro' && r.saving?.valued ? 'text-emerald-700' : 'text-slate-900'}`}>{value}</span></span></div>)}</div>

    <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-4"><InfoPanel r={r} /><KmPanel r={r} /><OperationPanel r={r} /><CostPanel r={r} savingsAvailable={fleet.savings_available} /></div>

    <div className="grid gap-3 xl:grid-cols-[22rem_minmax(0,1fr)]">
      <section className={box}><h2 className="mb-2 flex items-center gap-2 text-sm font-bold text-slate-800"><FileText className="h-4 w-4" />Documentos y soporte</h2>
        <p className="mb-2 text-xs text-slate-500">OT {r.refs.OT.join(', ') || '—'} · OC {r.refs.OC.join(', ') || '—'} · OS {r.refs.OS.join(', ') || '—'} · RQ {r.refs.RQ.join(', ') || '—'}</p>
        {r.readings.length > 0 && <div className="mb-2 flex flex-wrap gap-1.5">{r.readings.map((x, k) => <button key={k} type="button" disabled={!x.photo} onClick={() => x.photo && void openPhoto(x.photo)} className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-[#002855] hover:bg-slate-50">
          Foto odómetro {x.kind === 'INICIO' ? 'inicio' : 'cierre'} {fmtTime(x.at)}</button>)}</div>}
        <p className="mb-1 text-xs text-slate-500">Guías, notas, checklist y fotos de cada servicio (abre el documento original):</p>
        <RouteSources r={r} tab="documentos" /></section>

      <section className={box}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-bold text-slate-800">Evidencias / recorrido</h2>
          <div className="inline-flex rounded-lg border border-slate-300 p-0.5">{([['recorrido', 'Recorrido'], ['gps', 'GPS e incidencias'], ['observaciones', 'Observaciones']] as const).map(([k, label]) =>
            <button key={k} type="button" onClick={() => setTab(k)} aria-pressed={tab === k} className={`rounded-md px-3 py-1 text-sm font-medium ${tab === k ? 'bg-[#002855] text-white' : 'text-slate-700'}`}>{label}</button>)}</div></div>
        {tab === 'recorrido' && <div className="space-y-3"><Timeline r={r} /><JornadaRoutes d={r} openPhoto={openPhoto} /></div>}
        {tab === 'gps' && <div className="space-y-2 text-sm">
          <p>Km GPS {r.km_gps != null ? formatKm(r.km_gps) : '—'} · km odómetro {r.km_odo != null ? formatKm(r.km_odo) : '—'} · km estimado {r.km_est != null ? formatKm(r.km_est) : '—'}</p>
          {r.alerts.includes('GPS_INCOMPLETO') && <p className="flex items-center gap-1 text-amber-800"><AlertTriangle className="h-4 w-4" />GPS incompleto: registra menos del 70 % del odómetro.</p>}
          {!r.incidents.length ? <p className="text-emerald-700">Sin incidencias registradas.</p> : <ul className="space-y-1">{r.incidents.map(x => <li key={`${x.source}:${x.id}`} className="rounded-lg border border-red-200 bg-red-50/50 p-2">
            <b>{x.type.replaceAll('_', ' ').toLowerCase()}</b>{x.dispatch_number && ` · ruta ${x.dispatch_number}`} · {fmtTime(x.at)}<span className="block text-xs text-slate-600">{x.detail || 'Sin detalle'}</span></li>)}</ul>}
        </div>}
        {tab === 'observaciones' && <div className="space-y-2 text-sm">
          {r.alerts.length ? <ul className="flex flex-wrap gap-1">{r.alerts.map(a => <li key={a} className={`rounded px-2 py-0.5 text-xs font-semibold ${ALERTS[a]?.tone || 'bg-slate-100'}`}>{ALERTS[a]?.label || a}</li>)}</ul> : <p className="text-emerald-700">Jornada sin alertas.</p>}
          {r.end_source === 'SIGUIENTE_INICIO' && <p className="text-amber-800">El odómetro final se tomó del inicio del día siguiente: dato inferido, pendiente de validar.</p>}
          {r.operative === false && <p className="text-red-700">El checklist del día registró observaciones.</p>}
          {unit?.maintenance.length ? <div><p className="flex items-center gap-1 font-semibold"><Wrench className="h-4 w-4" />Mantenimiento pendiente de la unidad</p>
            <ul className="ml-5 list-disc text-xs text-slate-600">{unit.maintenance.map((m, k) => <li key={k}>{m.kind === 'PLAN' ? `Plan: ${m.detail}${m.due_date ? ` · vence ${m.due_date}` : ''}${m.due_km ? ` · ${formatKm(m.due_km)}` : ''}` : `Solicitud: ${m.detail}`}</li>)}</ul></div> : null}
        </div>}
      </section>
    </div>
  </div>
}
