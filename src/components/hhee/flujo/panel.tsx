'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Download } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card, Field, Kpi, btn2Cls, inputCls, useFlow } from './context'
import { call, fmtDate, fmtMoney, fmtNum, today, type Dashboard } from '@/lib/hhee/flujo'
import { exportAptXlsx } from '@/lib/apt/export'

// Panel gerencial: horas y costo aproximado AUTORIZADOS (antes de la ejecución): evolución, causas, recargos,
// supervisores, trabajadores recurrentes y día de la semana. No son horas trabajadas ni costo de planilla.
const tick = { fontSize: 11, fill: '#64748b' }
const NAVY = '#002855'
const RECARGO_COLORS = { '25 %': '#2563eb', '35 %': '#f59e0b', '100 %': '#dc2626', 'Sin clasificar': '#94a3b8' }
const CAUSE_COLORS = ['#002855', '#2563eb', '#0d9488', '#f59e0b', '#db2777', '#7c3aed', '#ea580c', '#16a34a', '#64748b']
const DOW = ['', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']

function range(preset: string): { from: string; to: string } {
  const t = today(), d = new Date(`${t}T12:00:00Z`)
  const iso = (x: Date) => x.toISOString().slice(0, 10)
  if (preset === 'prev') { const a = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)), b = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)); return { from: iso(a), to: iso(b) } }
  if (preset === '90') { const a = new Date(d); a.setUTCDate(a.getUTCDate() - 89); return { from: iso(a), to: t } }
  if (preset === 'year') return { from: `${t.slice(0, 4)}-01-01`, to: t }
  return { from: `${t.slice(0, 7)}-01`, to: t }
}

export function Panel() {
  const { ctx } = useFlow()
  const [f, setF] = useState(() => ({ ...range('month'), area_id: '', cause_id: '', supervisor_id: '', person_id: '' }))
  const [preset, setPreset] = useState('month')
  const [d, setD] = useState<Dashboard | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      setLoading(true)
      call<Dashboard>('hhee_flow_dashboard', { p: f }).then(r => { if (alive) { setD(r); setError('') } })
        .catch(e => { if (alive) setError(e instanceof Error ? e.message : 'No se pudo cargar') }).finally(() => { if (alive) setLoading(false) })
    }, 200)
    return () => { alive = false; clearTimeout(t) }
  }, [f])
  const set = (k: keyof typeof f, v: string) => setF(x => ({ ...x, [k]: v }))
  const choosePreset = (p: string) => { setPreset(p); if (p !== 'custom') setF(x => ({ ...x, ...range(p) })) }

  const recargos = useMemo(() => d ? [
    { name: '25 %', hours: d.metrics.hours_25 }, { name: '35 %', hours: d.metrics.hours_35 }, { name: '100 %', hours: d.metrics.hours_100 },
    ...(d.metrics.hours_unclassified > 0 ? [{ name: 'Sin clasificar', hours: d.metrics.hours_unclassified }] : []),
  ] : [], [d])
  const pareto = useMemo(() => {
    if (!d) return []
    const total = d.causes.reduce((t, c) => t + c.hours, 0) || 1
    let acc = 0
    return d.causes.map(c => { acc += c.hours; return { ...c, share: Math.round(c.hours / total * 1000) / 10, cum: Math.round(acc / total * 1000) / 10 } })
  }, [d])
  const byMonth = useMemo(() => {
    if (!d) return { rows: [] as Array<Record<string, number | string>>, causes: [] as string[] }
    const causes = [...new Set(d.causes_by_month.map(x => x.cause))]
    const map = new Map<string, Record<string, number | string>>()
    d.causes_by_month.forEach(x => { const o = map.get(x.month) ?? { month: x.month }; o[x.cause] = x.hours; map.set(x.month, o) })
    return { rows: [...map.values()], causes }
  }, [d])
  const supervisors = useMemo(() => {
    const m = new Map<string, string>()
    d?.supervisors.forEach(s => m.set(s.id, s.name))
    return [...m.entries()]
  }, [d])

  const exportar = () => d && exportAptXlsx(`panel-hhee-${d.from}-${d.to}`, {
    Resumen: [{ Desde: d.from, Hasta: d.to, 'Horas autorizadas': d.metrics.hours, 'Horas 25 %': d.metrics.hours_25, 'Horas 35 %': d.metrics.hours_35, 'Horas 100 %': d.metrics.hours_100,
      'Costo aproximado': d.metrics.cost ?? '', Trabajadores: d.metrics.workers, 'Solicitudes aprobadas': d.metrics.approved, Pendientes: d.metrics.pending,
      Observadas: d.metrics.observed, Rechazadas: d.metrics.rejected, 'Horas promedio hasta aprobar': d.metrics.approval_hours_avg ?? '', 'Trabajadores recurrentes': d.metrics.recurrent_workers }],
    Causas: pareto.map(c => ({ Causa: c.name, Horas: c.hours, '% horas': c.share, '% acumulado': c.cum, Solicitudes: c.requests, Trabajadores: c.workers, 'Costo aprox.': c.cost ?? '' })),
    Supervisores: d.supervisors.map(s => ({ Supervisor: s.name, Horas: s.hours, Solicitudes: s.requests, 'Costo aprox.': s.cost ?? '' })),
    Trabajadores: d.people.map(p => ({ Código: p.code, Trabajador: p.name, Horas: p.hours, 'Días con HHEE': p.days, [`Días en últimos ${d.recurrence_days} d`]: p.recent_days, Recurrente: p.recurrent ? 'Sí' : 'No', 'Costo aprox.': p.cost ?? '' })),
    Evolución: d.trend.map(t => ({ Fecha: t.day, Horas: t.hours, Solicitudes: t.requests, 'Costo aprox.': t.cost ?? '' })),
  })

  const m = d?.metrics
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <div role="group" aria-label="Período" className="flex flex-wrap gap-1">
          {([['month', 'Este mes'], ['prev', 'Mes anterior'], ['90', 'Últimos 90 días'], ['year', 'Este año'], ['custom', 'Personalizado']] as const).map(([v, l]) =>
            <button key={v} type="button" aria-pressed={preset === v} onClick={() => choosePreset(v)} className={`min-h-9 rounded-lg px-3 text-xs font-semibold ${preset === v ? 'bg-[#002855] text-white' : 'border border-slate-300 text-slate-600'}`}>{l}</button>)}
        </div>
        {preset === 'custom' && <>
          <Field label="Desde"><input className={inputCls} type="date" value={f.from} onChange={e => set('from', e.target.value)} /></Field>
          <Field label="Hasta"><input className={inputCls} type="date" value={f.to} onChange={e => set('to', e.target.value)} /></Field>
        </>}
        {ctx.areas.length > 1 && <Field label="Área"><select className={inputCls} value={f.area_id} onChange={e => set('area_id', e.target.value)}><option value="">Todas</option>{ctx.areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>}
        <Field label="Causa operativa"><select className={inputCls} value={f.cause_id} onChange={e => set('cause_id', e.target.value)}><option value="">Todas</option>{ctx.causes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Supervisor"><select className={inputCls} value={f.supervisor_id} onChange={e => set('supervisor_id', e.target.value)}><option value="">Todos</option>{supervisors.map(([id, n]) => <option key={id} value={id}>{n}</option>)}</select></Field>
        <Field label="Trabajador"><select className={`${inputCls} max-w-56`} value={f.person_id} onChange={e => set('person_id', e.target.value)}><option value="">Todos</option>{ctx.people.map(p => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select></Field>
        <button type="button" className={`${btn2Cls} ml-auto`} onClick={exportar} disabled={!d}><Download className="h-4 w-4" /> Excel gerencial</button>
      </div>
      <p className="flex items-center gap-2 text-xs text-slate-500"><AlertTriangle className="h-3.5 w-3.5 text-amber-600" /> Horas y costo aproximado <strong>autorizados</strong> (antes de la ejecución): no son horas trabajadas ni costo de planilla.</p>
      {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : !d || !m ? <p className="text-sm text-slate-500">Cargando…</p> : <div className={`grid gap-4 ${loading ? 'opacity-60' : ''}`}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Horas autorizadas" value={fmtNum(m.hours, 1)} tone="navy" hint={`25 %: ${fmtNum(m.hours_25)} h · 35 %: ${fmtNum(m.hours_35)} h · 100 %: ${fmtNum(m.hours_100)} h`} />
          <Kpi label="Costo aproximado" value={d.cost_visible ? fmtMoney(m.cost) : 'Reservado'} hint={d.cost_visible ? (m.cost_pending_lines ? `${m.cost_pending_lines} línea(s) con costo pendiente (completar ficha)` : 'Según la ficha de cada trabajador al aprobar') : 'Visible con permiso de costos'} />
          <Kpi label="Trabajadores" value={fmtNum(m.workers, 0)} hint={`${m.recurrent_workers} recurrente(s): ${d.recurrence_events}+ días con HHEE en ${d.recurrence_days} días`} tone={m.recurrent_workers ? 'warn' : 'default'} />
          <Kpi label="Solicitudes aprobadas" value={fmtNum(m.approved, 0)} hint={<><Link href="/hhee/solicitudes" className="underline">{m.pending} por aprobar</Link> · {m.observed} observadas · {m.rejected} rechazadas{m.approval_hours_avg != null ? ` · aprobación en ${fmtNum(m.approval_hours_avg)} h promedio` : ''}</>} tone={m.pending ? 'warn' : 'default'} />
        </div>
        <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
          <Card title="Evolución de horas autorizadas" subtitle={`Por fecha de trabajo · ${fmtDate(d.from)} – ${fmtDate(d.to)}`}>
            {d.trend.length ? <ResponsiveContainer width="100%" height={260}>
              <BarChart data={d.trend} margin={{ left: 0, right: 8 }}>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="day" tick={tick} tickFormatter={v => fmtDate(String(v)).slice(0, 5)} minTickGap={12} />
                <YAxis tick={tick} width={36} />
                <Tooltip labelFormatter={v => fmtDate(String(v))} formatter={(v, n) => [n === 'Horas' ? `${fmtNum(Number(v))} h` : String(v), String(n)]} />
                <Bar dataKey="hours" name="Horas" fill={NAVY} radius={[4, 4, 0, 0]} maxBarSize={48} />
              </BarChart>
            </ResponsiveContainer> : <p className="py-10 text-center text-sm text-slate-400">Sin horas autorizadas en el período.</p>}
          </Card>
          <Card title="Distribución por recargo" subtitle="Horas autorizadas">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={recargos} margin={{ left: 0, right: 8 }}>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tick={tick} /><YAxis tick={tick} width={36} />
                <Tooltip formatter={v => [`${fmtNum(Number(v))} h`, 'Horas']} />
                <Bar dataKey="hours" name="Horas" radius={[4, 4, 0, 0]}>{recargos.map(r => <Cell key={r.name} fill={RECARGO_COLORS[r.name as keyof typeof RECARGO_COLORS]} />)}</Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          <Card title="Principales causas (Pareto)" subtitle="Horas por causa y % acumulado: dónde actuar primero">
            {pareto.length ? <ResponsiveContainer width="100%" height={Math.max(240, pareto.length * 38)}>
              <ComposedChart data={pareto} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tick={tick} /><YAxis type="category" dataKey="name" tick={tick} width={170} />
                <Tooltip formatter={(v, n) => [n === 'Horas' ? `${fmtNum(Number(v))} h` : `${v} %`, String(n)]} />
                <Bar dataKey="hours" name="Horas" fill={NAVY} radius={[0, 4, 4, 0]} />
              </ComposedChart>
            </ResponsiveContainer> : <p className="py-10 text-center text-sm text-slate-400">Sin datos.</p>}
            {pareto.length > 0 && <table className="mt-3 w-full text-xs"><thead className="text-[10px] uppercase text-slate-500"><tr><th className="text-left">Causa</th><th className="text-right">Horas</th><th className="text-right">%</th><th className="text-right">% acum.</th><th className="text-right">Solic.</th>{d.cost_visible && <th className="text-right">Costo</th>}</tr></thead>
              <tbody className="divide-y divide-slate-100">{pareto.map(c => <tr key={c.id}><td className="py-1">{c.name}</td><td className="text-right">{fmtNum(c.hours)}</td><td className="text-right">{c.share} %</td><td className={`text-right ${c.cum <= 80 ? 'font-semibold text-[#002855]' : ''}`}>{c.cum} %</td><td className="text-right">{c.requests}</td>{d.cost_visible && <td className="text-right">{fmtMoney(c.cost)}</td>}</tr>)}</tbody></table>}
          </Card>
          <Card title="Causas por mes" subtitle="Horas autorizadas por causa (recurrencia de las causas en el tiempo)">
            {byMonth.rows.length ? <ResponsiveContainer width="100%" height={300}>
              <BarChart data={byMonth.rows} margin={{ left: 0, right: 8 }}>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="month" tick={tick} /><YAxis tick={tick} width={36} />
                <Tooltip formatter={(v, n) => [`${fmtNum(Number(v))} h`, String(n)]} /><Legend wrapperStyle={{ fontSize: 11 }} />
                {byMonth.causes.map((c, i) => <Bar key={c} dataKey={c} stackId="a" fill={CAUSE_COLORS[i % CAUSE_COLORS.length]} />)}
              </BarChart>
            </ResponsiveContainer> : <p className="py-10 text-center text-sm text-slate-400">Sin datos.</p>}
          </Card>
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          <Card title="Por supervisor solicitante">
            <table className="w-full text-sm"><thead className="text-[10px] uppercase text-slate-500"><tr><th className="py-1 text-left">Supervisor</th><th className="text-right">Solicitudes</th><th className="text-right">Horas</th>{d.cost_visible && <th className="text-right">Costo aprox.</th>}</tr></thead>
              <tbody className="divide-y divide-slate-100">{d.supervisors.map(s => <tr key={s.id}><td className="py-1.5">{s.name}</td><td className="text-right">{s.requests}</td><td className="text-right">{fmtNum(s.hours)}</td>{d.cost_visible && <td className="text-right">{fmtMoney(s.cost)}</td>}</tr>)}</tbody></table>
            {!d.supervisors.length && <p className="py-4 text-center text-sm text-slate-400">Sin datos.</p>}
          </Card>
          <Card title="Día de la semana" subtitle="Horas autorizadas según el día del trabajo">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={d.weekdays.map(w => ({ ...w, name: DOW[w.dow] }))} margin={{ left: 0, right: 8 }}>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tick={tick} /><YAxis tick={tick} width={36} />
                <Tooltip formatter={v => [`${fmtNum(Number(v))} h`, 'Horas']} />
                <Bar dataKey="hours" name="Horas" fill="#2563eb" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </div>
        <Card title="Trabajadores con más horas" subtitle={`Recurrente: ${d.recurrence_events} o más días con HHEE autorizadas en los últimos ${d.recurrence_days} días del período (riesgo de fatiga y dependencia)`}>
          <div className="overflow-x-auto"><table className="w-full min-w-[560px] text-sm"><thead className="text-[10px] uppercase text-slate-500"><tr><th className="py-1 text-left">Trabajador</th><th className="text-right">Horas</th><th className="text-right">Días con HHEE</th><th className="text-right">Días recientes</th>{d.cost_visible && <th className="text-right">Costo aprox.</th>}<th /></tr></thead>
            <tbody className="divide-y divide-slate-100">{d.people.map(p => <tr key={p.id} className={p.recurrent ? 'bg-amber-50/60' : ''}>
              <td className="py-1.5"><p className="font-semibold">{p.name}</p><p className="text-[10px] text-slate-500">{p.code}</p></td><td className="text-right">{fmtNum(p.hours)}</td><td className="text-right">{p.days}</td><td className="text-right">{p.recent_days}</td>
              {d.cost_visible && <td className="text-right">{fmtMoney(p.cost)}</td>}
              <td className="pl-2">{p.recurrent && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-900">Recurrente</span>}</td></tr>)}</tbody></table>
            {!d.people.length && <p className="py-4 text-center text-sm text-slate-400">Sin datos.</p>}</div>
        </Card>
      </div>}
    </div>
  )
}
