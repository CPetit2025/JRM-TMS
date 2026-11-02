'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, ArrowLeft, FileDown, FileSpreadsheet, Loader2, Trophy, Wrench } from 'lucide-react'
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { exportAptXlsx } from '@/lib/apt/export'
import { formatKm } from '@/lib/odometer'
import { ALERTS, MONTH, STATUS, iso, monthlySummary, soles, tn, type Fleet, type UnitMonth, type UnitMonthStatus } from '@/lib/jornada'

// Reporte mensual de flota (Vista 3, docs/control-jornada-plan.md): el mes de toda la flota visible, agregado de las
// mismas jornadas que la tabla (fleet_workdays); los totales del gráfico, de las unidades y del mes coinciden.

const UNIT_STATUS: Record<UnitMonthStatus, { label: string; tone: string }> = {
  CERRADA: { label: 'Cerrada', tone: 'bg-emerald-100 text-emerald-800' }, EN_PROCESO: { label: 'En proceso', tone: 'bg-amber-100 text-amber-800' },
  CON_INCIDENCIAS: { label: 'Con incidencias', tone: 'bg-red-100 text-red-700' }, SIN_OPERACION: { label: 'Sin operación', tone: 'bg-slate-100 text-slate-600' },
}
const RANK = { km_odo: 'Km odómetro', tn: 'Carga transportada', routes: 'Rutas', saving: 'Ahorro' } as const
type RankKey = keyof typeof RANK
const fmtRank = (k: RankKey, u: UnitMonth) => k === 'km_odo' ? formatKm(u.km_odo) : k === 'tn' ? tn(u.tn) : k === 'routes' ? String(u.routes) : `S/ ${soles(u.saving)}`

export default function ReporteMensualPage() {
  return <Suspense fallback={null}><ReporteMensual /></Suspense>
}

function ReporteMensual() {
  const supabase = useMemo(() => createClient(), [])
  const params = useSearchParams(); const router = useRouter(); const path = usePathname()
  const month = /^\d{4}-\d{2}$/.test(params.get('mes') || '') ? params.get('mes')! : iso(new Date()).slice(0, 7)
  const first = `${month}-01`
  const last = (() => { const d = new Date(`${first}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10) })()
  const [fleet, setFleet] = useState<Fleet | null>(null)
  const [loading, setLoading] = useState(false)
  const [sort, setSort] = useState<{ key: keyof UnitMonth; dir: 1 | -1 }>({ key: 'km_odo', dir: -1 })
  const [rank, setRank] = useState<RankKey>('km_odo')
  const chart = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase.rpc('fleet_workdays', { p_from: first, p_to: last })
    setLoading(false)
    if (error || !data?.success) { toast.error(data?.error || error?.message || 'No se pudo cargar el reporte'); setFleet(null); return }
    setFleet(data as Fleet)
  }, [supabase, first, last])
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [load])

  const m = useMemo(() => fleet ? monthlySummary(fleet, month) : null, [fleet, month])
  const units = useMemo(() => m ? [...m.operating].sort((a, b) => { const x = a[sort.key] ?? '', y = b[sort.key] ?? ''; return (x < y ? -1 : x > y ? 1 : 0) * sort.dir }) : [], [m, sort])
  const ranking = useMemo(() => m ? [...m.operating].filter(u => rank !== 'saving' || u.savingValued).sort((a, b) => b[rank] - a[rank]).slice(0, 5) : [], [m, rank])
  const tableHref = (plate?: string) => `/flota/reporte-unidad?desde=${first}&hasta=${last}${plate ? `&unidad=${encodeURIComponent(plate)}` : ''}`
  const title = MONTH.format(new Date(`${first}T12:00:00Z`)).replace(/^./, c => c.toUpperCase())
  const t = m?.totals

  const exportExcel = () => {
    if (!m) return
    exportAptXlsx(`Reporte_mensual_flota_${month}`, {
      'Por unidad': units.map(u => ({ Unidad: u.plate, Tipo: u.type, 'Conductor principal': u.driver, Jornadas: u.jornadas, 'Jornadas cerradas': u.closed, Rutas: u.routes, 'Km odómetro': u.km_odo, 'Km GPS': u.km_gps,
        'Carga (t)': u.tn, 'APT (t)': u.tn_apt, 'Costo real (S/)': u.cost, 'Ahorro (S/)': u.savingValued ? u.saving : null, Estado: UNIT_STATUS[u.status].label, Incidencias: u.incidents, 'Mantenimiento pendiente': u.maintenance })),
      Semanas: m.weeks.map(w => ({ Semana: w.label, Desde: w.from, Hasta: w.to, Rutas: w.routes, 'Carga (t)': w.tn })),
      Jornadas: m.rows.filter(r => r.status !== 'SIN_OPERACION').map(r => ({ Fecha: r.date, Unidad: r.plate, Conductores: (r.drivers || []).join(', '), Estado: r.status ? STATUS[r.status].label : '',
        'Odómetro inicio': r.odo_start, 'Odómetro fin': r.odo_end, 'Km odómetro': r.km_odo, 'Km GPS': r.km_gps, 'Km estimado': r.km_est, Rutas: r.routes, 'Carga (t)': r.tn, 'APT (t)': r.tn_apt,
        'Costo real (S/)': r.cost_total, 'Ahorro (S/)': r.saving?.valued ? r.saving.saving : null, Incidencias: r.incidents.length, Alertas: r.alerts.map(a => ALERTS[a]?.label || a).join(', ') })),
      Rutas: m.rows.flatMap(r => r.dispatches.map(x => ({ Fecha: r.date, Unidad: r.plate, Ruta: x.dispatch_number, Estado: x.status, Conductor: x.driver, 'Km GPS': x.km_gps, 'Km real': x.km_real, 'Km estimado': x.km_est,
        Paradas: x.stops.length, 'Costo (S/)': x.cost_total }))),
      Costos: m.rows.flatMap(r => r.dispatches.flatMap(x => (x.costs || []).map(c => ({ Fecha: r.date, Unidad: r.plate, Ruta: x.dispatch_number, OT: c.ot, Tipo: c.expense_type || c.kind, 'Importe (S/)': c.amount_pen, Estado: c.status })))),
      Alertas: [...m.alerts.flatMap(([a, list]) => list.map(x => ({ Alerta: ALERTS[a]?.label || a, Unidad: x.plate, Fecha: x.date }))),
        ...m.rows.flatMap(r => r.incidents.map(i => ({ Alerta: `Incidencia · ${i.type}`, Unidad: r.plate, Fecha: r.date, Detalle: i.detail })))],
    })
  }
  const exportPdf = async () => {
    if (!m || !t) return
    const [{ jsPDF }, { toPng }] = await Promise.all([import('jspdf'), import('html-to-image')])
    const pdf = new jsPDF({ orientation: 'landscape', format: 'a4' }); let y = 16
    const line = (text: string, bold = false, size = 9) => { pdf.setFont('helvetica', bold ? 'bold' : 'normal'); pdf.setFontSize(size)
      for (const s of pdf.splitTextToSize(text.replaceAll('−', '-'), 268) as string[]) { if (y > 195) { pdf.addPage(); y = 16 } pdf.text(s, 14, y); y += size * 0.5 + 1 } }
    line(`JRM · Reporte mensual de flota · ${title}`, true, 14)
    line(`Período ${first} a ${last} · Generado ${new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' })} (Lima)`)
    line(`Unidades activas ${t.activeUnits} de ${t.availableUnits} disponibles · Rutas ${t.routes} · Km odómetro ${t.km_odo} · Km GPS ${t.km_gps} · Carga ${t.tn} t · APT ${t.tn_apt} t · Ahorro S/ ${soles(t.saving)} · Incidencias ${t.incidents}`, true)
    if (chart.current) { try { const png = await toPng(chart.current, { backgroundColor: '#ffffff', pixelRatio: 2 }); if (y > 120) { pdf.addPage(); y = 16 } pdf.addImage(png, 'PNG', 14, y, 180, 70); y += 74 } catch { line('(No se pudo incluir el gráfico)') } }
    line('Desempeño por unidad', true, 11)
    for (const u of units) line(`${u.plate} · ${u.driver || '—'} · rutas ${u.routes} · km ${u.km_odo} · GPS ${u.km_gps} · carga ${u.tn} t · APT ${u.tn_apt} t · costo S/ ${soles(u.cost)} · ahorro ${u.savingValued ? `S/ ${soles(u.saving)}` : '—'} · ${UNIT_STATUS[u.status].label} · incidencias ${u.incidents}`)
    line('Principales alertas', true, 11)
    for (const [a, list] of m.alerts) line(`${ALERTS[a]?.label || a} (${list.length}): ${[...new Set(list.map(x => x.plate))].join(', ')}`)
    line(`Totales: rutas ${t.routes} · km ${t.km_odo} · carga ${t.tn} t · costo S/ ${soles(t.cost)} · ahorro S/ ${soles(t.saving)}`, true)
    pdf.save(`Reporte_mensual_flota_${month}.pdf`)
  }

  const kpis: Array<[string, string, string?, string?]> = t ? [
    ['Unidades activas', String(t.activeUnits), `de ${t.availableUnits} disponibles`], ['Rutas ejecutadas', String(t.routes)],
    ['Km odómetro', formatKm(t.km_odo)], ['Km GPS', formatKm(t.km_gps)],
    ['Ton transportadas', tn(t.tn)], ['Toneladas APT', tn(t.tn_apt)],
    ['Ahorro acumulado', fleet?.savings_available ? `S/ ${soles(t.saving)}` : '—', t.savingPending ? `${t.savingPending} servicio(s) sin valorizar` : undefined],
    ['Incidencias', String(t.incidents)],
  ] : []
  const sortTh = (k: keyof UnitMonth, children: React.ReactNode, right = false) => <th key={k} className={`px-2 py-2 ${right ? 'text-right' : ''}`}>
    <button type="button" onClick={() => setSort(s => ({ key: k, dir: s.key === k ? (s.dir * -1) as 1 | -1 : -1 }))} className="font-semibold uppercase">{children}{sort.key === k ? (sort.dir < 0 ? ' ↓' : ' ↑') : ''}</button></th>

  const control = 'h-9 rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-800 outline-none focus:border-[#002855] focus:ring-1 focus:ring-[#002855]'
  return <div className="min-w-0 space-y-3">
    <PageHeader showTitle title={`Reporte mensual de flota · ${title}`} description="Resumen operativo, kilometraje, carga y costos de toda la flota"
      actions={<>
        <Link href={tableHref()} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50"><ArrowLeft className="h-4 w-4" />Control de jornada</Link>
        <label className="text-[11px] font-medium text-slate-500">Mes<input aria-label="Mes del reporte" type="month" value={month} onChange={e => e.target.value && router.replace(`${path}?mes=${e.target.value}`)} className={`${control} ml-1`} /></label>
        <button type="button" disabled={!m} onClick={() => void exportPdf()} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"><FileDown className="h-4 w-4" />PDF</button>
        <button type="button" disabled={!m} onClick={exportExcel} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"><FileSpreadsheet className="h-4 w-4" />Excel</button>
      </>} />

    {loading && !m ? <p className="flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white p-8 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Cargando el mes…</p> : !m || !t ? null : <>
      <section aria-label="Indicadores del mes" className="grid grid-cols-2 divide-x divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white sm:grid-cols-4 sm:divide-y-0 xl:grid-cols-8">
        {kpis.map(([label, value, hint]) => <div key={label} className="min-w-0 px-2.5 py-2">
          <span className="block truncate text-[10px] font-medium text-slate-500">{label}</span>
          <span className={`block truncate text-base font-semibold tabular-nums ${label === 'Ahorro acumulado' ? 'text-emerald-800' : label === 'Incidencias' && t.incidents ? 'text-red-700' : 'text-slate-900'}`}>{value}</span>
          {hint && <span className="block truncate text-[10px] text-slate-500" title={hint}>{hint}</span>}
        </div>)}
      </section>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <section className="rounded-lg border border-slate-200 bg-white p-2.5"><h2 className="mb-1.5 text-sm font-semibold text-slate-800">Resumen del mes</h2>
          <div ref={chart} className="h-56 bg-white"><ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={m.weeks.map(w => ({ ...w, name: `${w.label} (${Number(w.from.slice(8))}–${Number(w.to.slice(8))})` }))} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="r" allowDecimals={false} tick={{ fontSize: 11 }} label={{ value: 'Rutas', angle: -90, position: 'insideLeft', fontSize: 11 }} />
              <YAxis yAxisId="t" orientation="right" tick={{ fontSize: 11 }} label={{ value: 't', angle: 90, position: 'insideRight', fontSize: 11 }} />
              <Tooltip formatter={(v, name) => name === 'Carga transportada (t)' ? [`${v} t`, name] : [v, name]} /><Legend />
              <Bar yAxisId="t" dataKey="tn" name="Carga transportada (t)" fill="#86efac" radius={[4, 4, 0, 0]} />
              <Line yAxisId="r" dataKey="routes" name="Rutas ejecutadas" stroke="#2563eb" strokeWidth={2} dot />
            </ComposedChart></ResponsiveContainer></div>
          <p className="text-[11px] text-slate-500">Semanas de lunes a domingo recortadas al mes: su suma es el total del mes.</p></section>

        <section className="rounded-lg border border-slate-200 bg-white p-2.5 text-sm"><h2 className="mb-1.5 text-sm font-semibold text-slate-800">Hallazgos del mes</h2>
          <p className="border-b border-slate-100 py-1.5"><span className="text-slate-500">Unidad con mayor kilometraje:</span> <b>{m.topKm ? `${m.topKm.plate} (${formatKm(m.topKm.km_odo)}, ${tn(m.topKm.tn)}, ${m.topKm.incidents} incidencia(s))` : '—'}</b></p>
          <p className="border-b border-slate-100 py-1.5"><span className="text-slate-500">Conductor con mayor actividad:</span> <b>{m.topDriver ? `${m.topDriver[0]} (${m.topDriver[1].routes} rutas, ${formatKm(Math.round(m.topDriver[1].km))})` : '—'}</b></p>
          <p className="border-b border-slate-100 py-1.5"><span className="text-slate-500">Jornadas cerradas:</span> <b className="text-emerald-700">{t.jornadas ? `${Math.round(1000 * t.closed / t.jornadas) / 10} %` : '—'}</b> ({t.closed} de {t.jornadas})</p>
          <p className="py-1.5"><span className="text-slate-500">Alertas principales:</span> {m.alerts.length ? m.alerts.slice(0, 4).map(([a, l]) => `${ALERTS[a]?.label || a} (${l.length})`).join(', ') : 'sin alertas'}</p>
          <p className="text-[11px] text-slate-500">El kilometraje mide actividad, no eficiencia.</p></section>
      </div>

      <section className="overflow-x-auto rounded-lg border border-slate-200 bg-white"><div className="px-2.5 pt-2.5 text-sm font-semibold text-slate-800">Desempeño por unidad</div>
        <table className="mt-1.5 min-w-[72rem] text-xs"><thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-600"><tr>
          {sortTh('plate', 'Unidad')}{sortTh('driver', 'Conductor principal')}{sortTh('routes', 'Rutas', true)}{sortTh('km_odo', 'Km odómetro', true)}{sortTh('km_gps', 'Km GPS', true)}
          {sortTh('tn', 'Carga', true)}{sortTh('tn_apt', 'APT', true)}{sortTh('cost', 'Costo real', true)}{sortTh('saving', 'Ahorro', true)}{sortTh('status', 'Estado')}{sortTh('incidents', 'Incidencias', true)}</tr></thead>
          <tbody className="divide-y divide-slate-100">{!units.length && <tr><td colSpan={11} className="p-6 text-center text-slate-500">Sin unidades con operación en el mes.</td></tr>}
            {units.map(u => <tr key={u.plate} className="hover:bg-slate-50">
              <td className="px-2 py-1.5 font-semibold"><Link href={tableHref(u.plate)} className="text-[#002855] underline">{u.plate}</Link>{u.maintenance > 0 && <span className="ml-1 inline-flex items-center text-amber-700" title="Mantenimiento pendiente"><Wrench className="h-3.5 w-3.5" /></span>}</td>
              <td className="px-2 py-1.5">{u.driver || '—'}</td><td className="px-2 py-1.5 text-right tabular-nums">{u.routes}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{formatKm(u.km_odo)}</td><td className="px-2 py-1.5 text-right tabular-nums">{formatKm(u.km_gps)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{tn(u.tn)}</td><td className="px-2 py-1.5 text-right tabular-nums">{tn(u.tn_apt)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">S/ {soles(u.cost)}</td><td className="px-2 py-1.5 text-right font-semibold tabular-nums text-emerald-700">{u.savingValued ? `S/ ${soles(u.saving)}` : '—'}</td>
              <td className="px-2 py-2"><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${UNIT_STATUS[u.status].tone}`}>{UNIT_STATUS[u.status].label}</span></td>
              <td className={`px-2 py-2 text-right ${u.incidents ? 'font-semibold text-red-700' : ''}`}>{u.incidents}</td></tr>)}</tbody></table>
        <p className="px-2.5 pb-2.5 pt-1 text-[10px] text-slate-500">Estado del mes: con incidencias si hubo alguna; en proceso si tiene jornadas abiertas o en revisión; cerrada si todas sus jornadas están cerradas.</p></section>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <section className="rounded-lg border border-slate-200 bg-white p-2.5"><h2 className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-slate-800"><Trophy className="h-4 w-4" />Top 5</h2>
          <div className="mb-1.5 flex flex-wrap gap-1">{(Object.keys(RANK) as RankKey[]).map(k => <button key={k} type="button" onClick={() => setRank(k)} aria-pressed={rank === k}
            className={`rounded-md px-2.5 py-1 text-xs font-semibold ${rank === k ? 'bg-[#002855] text-white' : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}>{RANK[k]}</button>)}</div>
          {!ranking.length ? <p className="text-sm text-slate-500">{rank === 'saving' ? 'Sin ahorro valorizado en el mes.' : 'Sin datos.'}</p>
            : <ol className="space-y-1 text-sm">{ranking.map((u, i) => <li key={u.plate} className="flex justify-between border-b border-slate-100 py-1"><span>{i + 1}. <b>{u.plate}</b></span><span className="tabular-nums">{fmtRank(rank, u)}</span></li>)}</ol>}</section>

        <section className="rounded-lg border border-slate-200 bg-white p-2.5"><h2 className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-slate-800"><AlertTriangle className="h-4 w-4" />Alertas y observaciones</h2>
          {!m.alerts.length && !t.incidents && !m.operating.some(u => u.maintenance) ? <p className="text-sm text-emerald-700">Sin alertas en el mes.</p> : <ul className="space-y-2 text-sm">
            {m.alerts.map(([a, list]) => <li key={a}><b>{ALERTS[a]?.label || a} ({list.length})</b>
              <span className="block text-xs text-slate-600">{list.map(x => <Link key={`${x.plate}/${x.date}`} href={`/flota/reporte-unidad/${encodeURIComponent(x.plate)}/${x.date}?desde=${first}&hasta=${last}`} className="mr-2 underline">{x.plate} {x.date.slice(8)}/{x.date.slice(5, 7)}</Link>)}</span></li>)}
            {t.incidents > 0 && <li><b>Incidencias registradas ({t.incidents})</b><span className="block text-xs text-slate-600">{m.operating.filter(u => u.incidents).map(u => `${u.plate} (${u.incidents})`).join(', ')}</span></li>}
            {m.operating.some(u => u.maintenance) && <li><b>Mantenimiento pendiente</b><span className="block text-xs text-slate-600">{m.operating.filter(u => u.maintenance).map(u => `${u.plate} (${u.maintenance})`).join(', ')}</span></li>}
          </ul>}</section>
      </div>

      <p className="text-xs text-slate-500">Unidades activas: con al menos una jornada con operación; disponibles: propias de sus sedes, sin las fuera de servicio. Costo real: costos imputados a las OT (Caja y combustible). El ahorro suma solo servicios valorizados.</p>
    </>}
  </div>
}
