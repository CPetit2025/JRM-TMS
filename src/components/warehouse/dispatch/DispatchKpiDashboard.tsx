'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Download, RefreshCw, RotateCcw, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { PeriodFilter, usePeriod } from '@/components/ui/period-filter'
import { fmt, fmtDate } from '@/lib/warehouse/packing-list'
import { AREAS, FINDING_CATEGORIES, SEVERITIES } from './findings'

type Kpi = { code: string; group: string; name: string; unit: string; value: number | null; num: number | null; den: number | null; n: number; universe: string; date_basis: string; state: string
  p50?: number | null; p90?: number | null; sin_peso?: number; [k: string]: unknown }
type Filters = Record<string, string>
type FilterField = { key: string; label: string; options?: Record<string, string>; placeholder?: string }
/** Configuración de un tablero: funciones de la base, páginas, filtros, gráfico por categoría (opcional) y tendencia */
export type KpiBoardConfig = { eyebrow: string; title: string; context: string; kpisRpc: string; detailRpc: string; pages: { key: string; label: string; codes: string[] }[]
  filters: FilterField[]; category?: { code: string; filter: string; labels: Record<string, string>; title: string; note: string; pages: string[] } | null
  trend: { a: { code: string; label: string }; b: { code: string; label: string }; title: string; pages: string[] } }
const PAGES: { key: string; label: string; codes: string[] }[] = [
  { key: 'A', label: 'Resumen de Jefatura', codes: ['D1', 'D2', 'D3', 'D4', 'D5', 'A2', 'A4', 'A5'] },
  { key: 'B', label: 'Operación', codes: ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'] },
  { key: 'C', label: 'Auditoría', codes: ['A1', 'A2', 'A3', 'A4', 'D7', 'D8'] },
  { key: 'D', label: 'Correcciones', codes: ['A5', 'A6', 'A7', 'A8'] },
  { key: 'E', label: 'Calidad de datos', codes: ['Q1', 'D1', 'A1'] },
]
export const DISPATCH_BOARD: KpiBoardConfig = {
  eyebrow: 'Despacho', title: 'Indicadores de Despacho y Auditoría', context: 'Despacho y Auditoría', kpisRpc: 'wh_dispatch_kpis', detailRpc: 'wh_dispatch_kpi_detail', pages: PAGES,
  filters: [{ key: 'ot', label: 'OT', placeholder: 'p. ej. 16544' }, { key: 'severity', label: 'Severidad', options: SEVERITIES }, { key: 'category', label: 'Categoría', options: FINDING_CATEGORIES }, { key: 'area', label: 'Área', options: AREAS }],
  category: { code: 'A3', filter: 'category', labels: FINDING_CATEGORIES, title: 'Hallazgos por categoría (kg) · toque una barra para filtrar', note: 'Un hallazgo con varias categorías aparece en cada una; los totales de masa (A3, A4) no la duplican.', pages: ['A', 'C'] },
  trend: { a: { code: 'A4', label: 'Incidencia %' }, b: { code: 'D1', label: 't preparadas' }, title: 'Tendencia semanal: incidencia por masa (%) y toneladas preparadas', pages: ['A', 'C'] },
}
const STATE: Record<string, string> = { CALCULADO: '', NO_CALCULABLE: 'No calculable: denominador 0', SIN_REGISTROS: 'Sin registros en el período' }
const COLORS = ['#002855', '#2563eb', '#0891b2', '#7c3aed', '#c2410c', '#15803d', '#be123c', '#a16207', '#475569', '#0f766e', '#9333ea']
// CSV seguro: evita que una celda se interprete como fórmula al abrirla en Excel
const cell = (v: unknown) => { let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"` }
const csv = (name: string, context: string, rows: Record<string, unknown>[]) => {
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))]
  const text = [cell(context), cols.map(cell).join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\r\n')
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' })); a.download = name; a.click(); URL.revokeObjectURL(a.href)
}
const prevRange = (from: string, to: string): [string, string] => {
  const d = (s: string) => new Date(s + 'T12:00:00Z'), days = Math.round((d(to).getTime() - d(from).getTime()) / 86400000) + 1
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
  return [iso(d(from).getTime() - days * 86400000), iso(d(from).getTime() - 86400000)]
}
const show = (k: Kpi) => k.value == null ? '—' : `${fmt(k.value, k.unit === 't' ? 3 : 1)}${k.unit === '%' ? ' %' : ' ' + k.unit}`

/** Tablero de Despacho y Auditoría: filtros globales, comparación con el período anterior, desglose hasta el registro y exportación. Sin semáforos (metas por definir). */
export function DispatchKpiDashboard({ config = DISPATCH_BOARD }: { config?: KpiBoardConfig }) {
  const PAGES = config.pages
  const EMPTY: Filters = Object.fromEntries(config.filters.map(x => [x.key, '']))
  const period = usePeriod()
  const [from, to] = period.range
  const [filters, setFilters] = useState<Filters>(EMPTY)
  const [page, setPage] = useState('A')
  const [kpis, setKpis] = useState<Record<string, Kpi>>({})
  const [prev, setPrev] = useState<Record<string, Kpi>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<Kpi | null>(null)
  const [detail, setDetail] = useState<Record<string, unknown>[] | null>(null)
  const [cats, setCats] = useState<{ name: string; key: string; hallazgos: number; kg: number }[]>([])
  const [trend, setTrend] = useState<{ semana: string; a: number | null; b: number | null }[]>([])
  const f = useMemo(() => Object.fromEntries(Object.entries(filters).filter(([, v]) => v)), [filters])
  const context = `${config.context} · ${from} a ${to}${Object.keys(f).length ? ' · filtros ' + Object.entries(f).map(([k, v]) => `${k}=${v}`).join(', ') : ''}`

  const load = useCallback(async () => {
    setLoading(true); setError('')
    const db = createClient(); const [pf, pt] = prevRange(from, to)
    const cat = config.category
    const [cur, before, det] = await Promise.all([
      db.rpc(config.kpisRpc, { p_from: from, p_to: to, p_filters: f }), db.rpc(config.kpisRpc, { p_from: pf, p_to: pt, p_filters: f }),
      cat ? db.rpc(config.detailRpc, { p_code: cat.code, p_from: from, p_to: to, p_filters: { ...f, [cat.filter]: '' } }) : Promise.resolve({ data: [] })])
    if (cur.error) { setError(cur.error.message); setLoading(false); return }
    const map = (x: { kpis: Kpi[] } | null) => Object.fromEntries((x?.kpis || []).map(k => [k.code, k]))
    setKpis(map(cur.data)); setPrev(before.error ? {} : map(before.data))
    // Hallazgos por categoría (cantidad y masa); una categoría compartida no duplica en el total, aquí se ve por categoría
    const acc: Record<string, { hallazgos: number; kg: number }> = {}
    for (const r of (det.data || []) as { categories?: string[]; kg: number | null }[]) for (const c of r.categories || []) { acc[c] ??= { hallazgos: 0, kg: 0 }; acc[c].hallazgos++; acc[c].kg += Number(r.kg || 0) }
    setCats(Object.entries(acc).map(([key, v]) => ({ key, name: cat?.labels[key] || key, ...v })).sort((a, b) => b.kg - a.kg))
    // Tendencia semanal (hasta 8 semanas del período)
    const weeks: [string, string][] = []; let s = new Date(from + 'T12:00:00Z')
    while (s.toISOString().slice(0, 10) <= to && weeks.length < 8) { const e = new Date(Math.min(s.getTime() + 6 * 86400000, new Date(to + 'T12:00:00Z').getTime())); weeks.push([s.toISOString().slice(0, 10), e.toISOString().slice(0, 10)]); s = new Date(e.getTime() + 86400000) }
    const series = weeks.length > 1 ? await Promise.all(weeks.map(([a, b]) => db.rpc(config.kpisRpc, { p_from: a, p_to: b, p_filters: f }).then(r => {
      const m = map(r.data); return { semana: a.slice(5), a: m[config.trend.a.code]?.value ?? null, b: m[config.trend.b.code]?.value ?? null } }))) : []
    setTrend(series); setLoading(false)
  }, [from, to, f, config])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])
  const openKpi = async (k: Kpi) => {
    setOpen(k); setDetail(null)
    const r = await createClient().rpc(config.detailRpc, { p_code: k.code, p_from: from, p_to: to, p_filters: f })
    setDetail(r.error ? [] : (r.data || []) as Record<string, unknown>[])
  }
  const delta = (k: Kpi) => {
    const p = prev[k.code]; if (!p || p.value == null || k.value == null) return null
    const d = Number(k.value) - Number(p.value)
    return k.unit === '%' ? `${d >= 0 ? '+' : ''}${fmt(d, 1)} pp` : Number(p.value) === 0 ? null : `${d >= 0 ? '+' : ''}${fmt(100 * d / Number(p.value), 1)} %`
  }
  const shown = (PAGES.find(p => p.key === page) || PAGES[0]).codes.map(c => kpis[c]).filter(Boolean)
  const sel = 'rounded-lg border border-slate-300 px-2 py-1.5 text-sm'

  return <div className="space-y-4">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div><p className="text-xs font-bold uppercase tracking-widest text-blue-700">{config.eyebrow}</p>
        <h1 className="mt-1 text-3xl font-black text-[#002855]">{config.title}</h1>
        <p className="mt-1 text-sm text-slate-600">Cada cifra muestra numerador, denominador y registros. Sin semáforos: las metas se definen con 1–2 meses de datos.</p></div>
      <div className="flex gap-2">
        <button onClick={() => csv(`indicadores-${from}-${to}.csv`, context, Object.values(kpis).map(k => ({ ...k, anterior: prev[k.code]?.value ?? null })))} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold"><Download size={16}/>Exportar</button>
        <button onClick={() => void load()} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold"><RefreshCw size={16}/>Actualizar</button></div>
    </header>
    <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-3">
      <PeriodFilter state={period}/>
      <div className="flex flex-wrap items-end gap-2 text-sm">
        {config.filters.map(x => x.options
          ? <label key={x.key} className="font-semibold">{x.label}<select value={filters[x.key] || ''} onChange={e => setFilters({ ...filters, [x.key]: e.target.value })} className={`ml-1 ${sel}`}><option value="">Todas</option>{Object.entries(x.options).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          : <label key={x.key} className="font-semibold">{x.label}<input value={filters[x.key] || ''} onChange={e => setFilters({ ...filters, [x.key]: e.target.value.trim() })} placeholder={x.placeholder} className={`ml-1 w-32 ${sel}`}/></label>)}
        <button type="button" onClick={() => setFilters(EMPTY)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-1.5 font-semibold"><RotateCcw size={14}/>Restablecer</button>
      </div>
    </section>
    <nav className="flex flex-wrap gap-1.5" aria-label="Páginas del tablero">{PAGES.map(p => <button key={p.key} type="button" aria-pressed={page === p.key} onClick={() => setPage(p.key)}
      className={`rounded-full px-3 py-1.5 text-sm font-semibold ${page === p.key ? 'bg-[#002855] text-white' : 'bg-white ring-1 ring-slate-200'}`}>{p.key} · {p.label}</button>)}</nav>
    {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}
    {loading ? <p className="p-8 text-center text-slate-500">Calculando indicadores…</p> : <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{shown.map(k => <button key={k.code} type="button" onClick={() => void openKpi(k)} className="rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm hover:border-[#002855]">
        <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{k.code} · {k.group}</p>
        <p className="mt-1 text-sm font-semibold text-[#002855]">{k.name}</p>
        <p className="mt-2 text-3xl font-black text-[#002855]">{show(k)}</p>
        {STATE[k.state] && <p className="text-xs font-semibold text-slate-500">{STATE[k.state]}</p>}
        <p className="mt-1 text-xs text-slate-600">{k.den != null ? `${fmt(k.num, 1)} / ${fmt(k.den, 1)} · ` : ''}n = {k.n}{k.p90 != null ? ` · p90 ${fmt(k.p90, 1)} ${k.unit}` : ''}{delta(k) ? ` · vs. anterior ${delta(k)}` : ''}</p>
        {Number(k.sin_peso || 0) > 0 && <p className="text-xs font-semibold text-amber-800">{String(k.sin_peso)} paquete(s) sin peso no incluidos en kg</p>}
      </button>)}</div>
      {(config.category?.pages.includes(page) || config.trend.pages.includes(page)) && <div className="grid gap-3 lg:grid-cols-2">
        {config.category?.pages.includes(page) && <section className="rounded-xl border border-slate-200 bg-white p-3"><h2 className="text-sm font-bold text-[#002855]">{config.category.title}</h2>
          {cats.length === 0 ? <p className="p-6 text-center text-sm text-slate-500">Sin hallazgos en el período.</p> : <div className="h-64"><ResponsiveContainer width="100%" height="100%">
            <BarChart data={cats} layout="vertical" margin={{ left: 20 }}><CartesianGrid strokeDasharray="3 3"/><XAxis type="number"/><YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11 }}/>
              <Tooltip formatter={(v, n) => [n === 'kg' ? `${fmt(Number(v))} kg` : v, n === 'kg' ? 'Masa' : 'Hallazgos']}/>
              <Bar dataKey="kg" onClick={d => { const key = (d as unknown as { payload?: { key?: string } }).payload?.key; if (key && config.category) { const k2 = config.category.filter; setFilters({ ...filters, [k2]: filters[k2] === key ? '' : key }) } }} cursor="pointer">
                {cats.map((c, i) => <Cell key={c.key} fill={config.category && filters[config.category.filter] && filters[config.category.filter] !== c.key ? '#cbd5e1' : COLORS[i % COLORS.length]}/>)}</Bar></BarChart></ResponsiveContainer></div>}
          <p className="text-xs text-slate-500">{config.category.note}</p></section>}
        {config.trend.pages.includes(page) && <section className="rounded-xl border border-slate-200 bg-white p-3"><h2 className="text-sm font-bold text-[#002855]">{config.trend.title}</h2>
          {trend.length < 2 ? <p className="p-6 text-center text-sm text-slate-500">Elija un período de dos semanas o más para ver la tendencia.</p> : <div className="h-64"><ResponsiveContainer width="100%" height="100%">
            <LineChart data={trend}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="semana"/><YAxis yAxisId="a"/><YAxis yAxisId="b" orientation="right"/><Tooltip/>
              <Line yAxisId="a" type="monotone" dataKey="a" name={config.trend.a.label} stroke="#be123c" connectNulls={false}/><Line yAxisId="b" type="monotone" dataKey="b" name={config.trend.b.label} stroke="#002855"/></LineChart></ResponsiveContainer></div>}
        </section>}</div>}
    </>}
    {open && <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-2 sm:items-center" onClick={() => setOpen(null)}>
      <div role="dialog" aria-modal="true" aria-label={open.name} onClick={e => e.stopPropagation()} className="max-h-[calc(100dvh-1rem)] w-full max-w-4xl space-y-3 overflow-y-auto rounded-xl bg-white p-4 text-sm">
        <div className="flex items-start justify-between gap-2"><div><p className="text-xs font-bold uppercase text-slate-500">{open.code} · {open.group}</p><h2 className="text-xl font-black text-[#002855]">{open.name}: {show(open)}</h2></div>
          <button type="button" aria-label="Cerrar" onClick={() => setOpen(null)} className="rounded-lg border p-1.5"><X size={16}/></button></div>
        <dl className="grid gap-1 sm:grid-cols-2">
          <div><dt className="text-xs text-slate-500">Fórmula y universo</dt><dd>{open.universe}</dd></div>
          <div><dt className="text-xs text-slate-500">Fecha base</dt><dd>{open.date_basis} · {from} a {to} (hora de Lima)</dd></div>
          <div><dt className="text-xs text-slate-500">Numerador / denominador</dt><dd>{open.den != null ? `${fmt(open.num, 2)} / ${fmt(open.den, 2)}` : 'No aplica (total)'} · n = {open.n}</dd></div>
          <div><dt className="text-xs text-slate-500">Estado</dt><dd>{STATE[open.state] || 'Calculado'}{prev[open.code]?.value != null && ` · período anterior ${show(prev[open.code])}`}</dd></div>
          {Object.entries(open).filter(([k]) => !['code', 'group', 'name', 'unit', 'value', 'num', 'den', 'n', 'universe', 'date_basis', 'state'].includes(k)).map(([k, v]) => <div key={k}><dt className="text-xs text-slate-500">{k.replace(/_/g, ' ')}</dt><dd>{v == null ? '—' : String(v)}</dd></div>)}
        </dl>
        <div className="flex items-center justify-between"><b>Registros ({detail?.length ?? '…'})</b>{detail && detail.length > 0 && <button type="button" onClick={() => csv(`${open.code}-${from}-${to}.csv`, `${context} · ${open.code} ${open.name}`, detail)} className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-semibold"><Download size={14}/>Exportar detalle</button>}</div>
        {!detail ? <p className="text-slate-500">Cargando…</p> : detail.length === 0 ? <p className="text-slate-500">Sin registros.</p> : <div className="max-h-96 overflow-auto rounded-lg border"><table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-50"><tr>{Object.keys(detail[0]).filter(c => c !== 'tipo' && c !== 'tiempos').map(c => <th key={c} className="p-1.5 text-left">{c.replace(/_/g, ' ')}</th>)}</tr></thead>
          <tbody>{detail.map((r, i) => <tr key={i} className="border-t">{Object.keys(detail[0]).filter(c => c !== 'tipo' && c !== 'tiempos').map(c => { const v = r[c]
            return <td key={c} className="p-1.5">{v == null ? '—' : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? fmtDate(v) : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}</td> })}</tr>)}</tbody></table></div>}
      </div></div>}
  </div>
}
