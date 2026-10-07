'use client'
import { DataTable } from '@/components/ui/data-table'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { HistorialResumen } from '@/components/mantenimiento/HistorialResumen'
import { Activity, AlertTriangle, BarChart3, Gauge, Loader2, RefreshCw, ShieldAlert, Timer, Wrench, CircleDot, Sparkles } from 'lucide-react'

// Centro de Control CMMS (Fase 12): todos los indicadores se calculan en la BD desde las fuentes
// reales (get_cmms_kpis / get_cmms_copilot_brief); no hay tablas de dashboard (migración 20260928150000).

const supabase = createClient()
type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const money = (n: unknown) => `S/ ${Number(n || 0).toLocaleString('es-PE', { maximumFractionDigits: 0 })}`
const num = (n: unknown, d = 1) => (n == null ? '—' : Number(n).toLocaleString('es-PE', { maximumFractionDigits: d }))
const STATUS_ORDER = ['DISPONIBLE', 'ASIGNADA', 'EN_OPERACION', 'OBSERVADA', 'MANTENIMIENTO', 'BLOQUEADA']
const STATUS_COLOR: Record<string, string> = { DISPONIBLE: 'bg-emerald-500', ASIGNADA: 'bg-sky-500', EN_OPERACION: 'bg-blue-600', OBSERVADA: 'bg-yellow-400', MANTENIMIENTO: 'bg-amber-500', BLOQUEADA: 'bg-red-600' }
const CATEGORY_LABEL: Record<string, string> = { MANTENIMIENTO: 'Mantenimiento', OPERACION: 'Operación', COMBUSTIBLE: 'Combustible', NEUMATICOS: 'Neumáticos', MULTAS: 'Multas', SINIESTROS: 'Siniestros', ALQUILER: 'Alquiler' }
const ymd = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Lima' })

function load(days: number) {
  const end = new Date()
  const start = new Date(end.getTime() - (days - 1) * 86_400_000)
  return Promise.all([
    supabase.rpc('get_cmms_kpis', { p_start: ymd(start), p_end: ymd(end), p_plates: null }),
    supabase.rpc('get_cmms_copilot_brief', { p_plates: null }),
  ])
}

export default function CentroControlPage() {
  const [days, setDays] = useState(30)
  const [kpi, setKpi] = useState<Row | null>(null)
  const [brief, setBrief] = useState<Row | null>(null)
  const [loading, setLoading] = useState(true)

  const apply = useCallback(([k, b]: Awaited<ReturnType<typeof load>>) => {
    if (k.error) toast.error('No se pudieron calcular los KPI: ' + k.error.message)
    setKpi(k.data || null); setBrief(b.data || null)
    setLoading(false)
  }, [])
  const refresh = useCallback((d: number) => { setLoading(true); return load(d).then(apply) }, [apply])
  useEffect(() => { load(30).then(apply) }, [apply])

  const snapshot = useMemo(() => {
    const s = (kpi?.snapshot || {}) as Record<string, number>
    const total = Object.values(s).reduce((a, b) => a + Number(b), 0)
    return { s, total }
  }, [kpi])
  const categories = useMemo(() => Object.entries((kpi?.costs?.by_category || {}) as Record<string, number>).sort(([, a], [, b]) => Number(b) - Number(a)), [kpi])
  const maxCat = Math.max(1, ...categories.map(([, v]) => Number(v)))

  const cards: [string, string, React.ReactNode, React.ReactNode][] = kpi ? [
    ['Disponibilidad', kpi.availability_pct != null ? `${num(kpi.availability_pct, 2)}%` : '—', <Gauge key="g" className="w-4 h-4" />, `${num(kpi.downtime_hours)} h fuera de servicio`],
    ['MTBF', kpi.mtbf_hours != null ? `${num(kpi.mtbf_hours)} h` : 'sin fallas', <Activity key="a" className="w-4 h-4" />, `${kpi.failures} fallas en el periodo`],
    ['MTTR', kpi.mttr_hours != null ? `${num(kpi.mttr_hours)} h` : '—', <Timer key="t" className="w-4 h-4" />, 'OT correctivas cerradas'],
    ['Backlog', `${kpi.backlog?.open_requests ?? 0}`, <AlertTriangle key="b" className="w-4 h-4" />, `${kpi.backlog?.critical ?? 0} críticas · prom. ${num(kpi.backlog?.avg_age_days)} días`],
    ['Preventivo', kpi.preventive_pct != null ? `${num(kpi.preventive_pct)}%` : '—', <Wrench key="p" className="w-4 h-4" />, `${kpi.preventive_work_orders} prev. / ${kpi.corrective_work_orders} corr.`],
    ['Costo por km', kpi.costs?.cost_per_km != null ? `S/ ${num(kpi.costs.cost_per_km, 3)}` : '—', <BarChart3 key="c" className="w-4 h-4" />, `${num(kpi.costs?.km, 0)} km reales`],
    ['Costo por hora', kpi.costs?.cost_per_hour != null ? `S/ ${num(kpi.costs.cost_per_hour, 2)}` : '—', <Timer key="h" className="w-4 h-4" />, 'equipos con horómetro'],
    ['Mantenimiento por unidad', money(kpi.costs?.maintenance_per_unit), <Wrench key="m" className="w-4 h-4" />, `${kpi.units} unidades activas`],
    ['TCO del periodo', money(kpi.costs?.total), <BarChart3 key="tc" className="w-4 h-4" />, 'libro de costos'],
    ['Neumáticos por cambiar', `${kpi.tires?.to_change ?? 0}`, <CircleDot key="n" className="w-4 h-4" />, kpi.tires?.avg_cost_per_km != null ? `S/ ${num(kpi.tires.avg_cost_per_km, 4)}/km prom.` : `${kpi.tires?.installed ?? 0} instalados`],
  ] : []

  return (
    <div className="p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Centro de Control de Mantenimiento</h1>
          <p className="text-sm text-slate-500">Indicadores del sistema (OT, fallas, lecturas y libro de costos por activo) y, arriba, el historial completo.</p>
        </div>
        <div className="flex gap-2">
          <select value={days} onChange={e => { const d = Number(e.target.value); setDays(d); refresh(d) }} className="border rounded-lg px-3 py-2 text-sm">
            <option value={7}>Últimos 7 días</option><option value={30}>Últimos 30 días</option><option value={90}>Últimos 90 días</option><option value={365}>Últimos 365 días</option>
          </select>
          <button onClick={() => refresh(days)} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-2"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />Actualizar</button>
        </div>
      </div>

      <HistorialResumen />
      {loading || !kpi ? <div className="p-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div> : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {cards.map(([label, value, icon, hint]) => (
              <div key={label} className="bg-white border rounded-xl p-3">
                <div className="text-xs text-slate-500 flex items-center gap-1">{icon}{label}</div>
                <div className="text-2xl font-bold text-slate-900">{value}</div>
                <div className="text-[11px] text-slate-400">{hint}</div>
              </div>
            ))}
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            <div className="bg-white border rounded-xl p-4">
              <h3 className="font-semibold mb-3">Estado de la flota ({snapshot.total} unidades)</h3>
              <div className="flex h-4 rounded overflow-hidden mb-3">
                {STATUS_ORDER.filter(s => snapshot.s[s]).map(s => <div key={s} className={STATUS_COLOR[s]} style={{ width: `${(snapshot.s[s] / Math.max(1, snapshot.total)) * 100}%` }} title={`${s}: ${snapshot.s[s]}`} />)}
              </div>
              <ul className="text-sm space-y-1">{STATUS_ORDER.map(s => <li key={s} className="flex justify-between"><span className="flex items-center gap-2"><span className={`w-2.5 h-2.5 rounded-full ${STATUS_COLOR[s]}`} />{s.replace('_', ' ')}</span><b>{snapshot.s[s] || 0}</b></li>)}</ul>
              <p className="text-xs text-slate-500 mt-2">{kpi.open_work_orders} OT abiertas</p>
            </div>
            <div className="bg-white border rounded-xl p-4">
              <h3 className="font-semibold mb-3">Costos del periodo por categoría</h3>
              {categories.length === 0 ? <p className="text-sm text-slate-500">Sin costos en el periodo.</p> : (
                <ul className="space-y-2 text-sm">{categories.map(([c, v]) => (
                  <li key={c}><div className="flex justify-between"><span>{CATEGORY_LABEL[c] || c}</span><b>{money(v)}</b></div>
                    <div className="h-2 rounded bg-slate-100"><div className="h-2 rounded bg-[#002855]" style={{ width: `${(Number(v) / maxCat) * 100}%` }} /></div></li>))}</ul>
              )}
            </div>
            <div className="bg-white border rounded-xl p-4">
              <h3 className="font-semibold mb-3 flex items-center gap-2"><Sparkles className="w-4 h-4 text-amber-500" />Alertas y anomalías</h3>
              {(brief?.anomalies || []).length === 0 && (brief?.blocked_or_unavailable || []).length === 0 ? <p className="text-sm text-slate-500">Sin alertas.</p> : (
                <ul className="text-sm space-y-1.5 max-h-56 overflow-y-auto">
                  {(brief?.blocked_or_unavailable || []).slice(0, 6).map((b: Row) => <li key={`b-${b.plate}`}><ShieldAlert className="w-3.5 h-3.5 inline text-red-600 mr-1" /><b>{b.plate}</b> {b.status} · {(b.motives || [])[0] || b.eligibility}</li>)}
                  {(brief?.anomalies || []).slice(0, 8).map((a: Row, i: number) => <li key={`a-${i}`}><AlertTriangle className="w-3.5 h-3.5 inline text-amber-500 mr-1" /><b>{a.plate}</b> {a.type.replace('_', ' ').toLowerCase()}: {a.detail}</li>)}
                </ul>
              )}
              <Link href="/mantenimiento/copiloto" className="text-xs text-blue-600 mt-2 inline-block">Ver Copiloto →</Link>
            </div>
          </div>

          {kpi.recurrent_failures?.length > 0 && (
            <div className="bg-white border rounded-xl p-4">
              <h3 className="font-semibold mb-2">Fallas recurrentes (≥3 reportes en 90 días)</h3>
              <ul className="text-sm space-y-1">{kpi.recurrent_failures.map((r: Row) => <li key={r.vehicle_plate}><Link href={`/mantenimiento/flota/${r.vehicle_plate}`} className="font-semibold text-[#002855]">{r.vehicle_plate}</Link> · {r.reports_90d} reportes · <span className="text-slate-500">{r.descriptions}</span></li>)}</ul>
            </div>
          )}

          <div className="bg-white border rounded-xl overflow-x-auto">
            <DataTable className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>
                <th className="text-left p-3">Unidad</th><th className="text-right p-3">Disponibilidad</th><th className="text-right p-3">Fuera de servicio</th><th className="text-right p-3">Fallas</th>
                <th className="text-right p-3">MTBF</th><th className="text-right p-3">Km</th><th className="text-right p-3">Costo</th><th className="text-right p-3">Costo/km</th>
              </tr></thead>
              <tbody className="divide-y">
                {(kpi.per_vehicle || []).map((v: Row) => (
                  <tr key={v.plate}>
                    <td className="p-3"><Link href={`/mantenimiento/flota/${v.plate}`} className="font-semibold text-[#002855]">{v.plate}</Link><div className="text-xs text-slate-500">{v.type} · {v.status}</div></td>
                    <td className={`p-3 text-right font-semibold ${Number(v.availability_pct) < 90 ? 'text-red-600' : Number(v.availability_pct) < 97 ? 'text-amber-600' : 'text-emerald-700'}`}>{num(v.availability_pct, 2)}%</td>
                    <td className="p-3 text-right">{num(v.downtime_hours)} h</td><td className="p-3 text-right">{v.failures}</td>
                    <td className="p-3 text-right">{v.mtbf_hours != null ? `${num(v.mtbf_hours)} h` : '—'}</td><td className="p-3 text-right">{num(v.km, 0)}</td>
                    <td className="p-3 text-right">{money(v.cost)}</td><td className="p-3 text-right">{v.cost_per_km != null ? `S/ ${num(v.cost_per_km, 3)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
          <p className="text-xs text-slate-400">Disponibilidad = 1 − horas fuera de servicio por OT (intervalos fusionados) / (unidades × horas). MTBF = horas disponibles / fallas. MTTR = promedio de horas fuera de servicio de OT correctivas cerradas. Costo/km = libro de costos / km reales.</p>
        </>
      )}
    </div>
  )
}
