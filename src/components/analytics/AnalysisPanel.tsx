'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowDown, ArrowUp, Download, FileText, Info, X } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { exportReport } from '@/lib/analytics/export'
import { formatValue, groups, type AnalysisRow, type Dataset, type Filters, type Metric, type Perspective } from '@/lib/analytics/model'
import { dispatchStatusLabel } from '@/lib/dispatch-status'

export function MetricCard({ metric: m, previous, onClick }: { metric: Metric; previous?: Metric; onClick?: () => void }) {
  const delta = m.value != null && previous?.value != null ? m.value - previous.value : null
  const good = delta != null && m.direction ? (m.direction === 'up' ? delta >= 0 : delta <= 0) : null
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-2"><span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{m.label}</span><span title={m.formula}><Info className="h-3.5 w-3.5 text-slate-400" /></span></div>
      <button disabled={!onClick} onClick={onClick} className="mt-2 max-w-full break-words text-left text-2xl font-extrabold text-[#002855] disabled:cursor-default">{formatValue(m.value, m.unit)}</button>
      {previous && <div className="mt-1 text-xs text-slate-500">Anterior: {formatValue(previous.value, previous.unit)}{delta !== null && <span className={`ml-1 ${good === null ? '' : good ? 'text-emerald-700' : 'text-amber-700'}`}>({delta > 0 ? '+' : ''}{formatValue(delta, m.unit === '%' ? 'pp' : m.unit)})</span>}</div>}
      <details className="mt-2 text-[11px] text-slate-500"><summary className="cursor-pointer">Cómo se calcula</summary><p className="mt-1">{m.formula}</p></details>
    </div>
  )
}
const VALUE_LABELS: Record<string, string> = { requests: 'Solicitudes', incident: 'Incidencia', income: 'Ingresos S/', expenses: 'Gastos S/', margin: 'Margen S/', km: 'Km', availability: 'Disponibilidad %', failures: 'Fallas', cost: 'Costo S/', downtime: 'Fuera de servicio h', tn_in: 'Ingreso t', tn_out: 'Salida t', tn_saldo: 'Saldo t', days: 'Días con saldo', cost_km: 'Costo total/km', cost_tkm: 'Costo total/t·km', cost_hour: 'Costo/h' }
export function AnalysisPanel({ section, title, data, previous, filters, blocked, onFilter }: {
  section: Perspective; title: string; data: Dataset; previous?: Dataset | null; filters: Filters; blocked: boolean; onFilter: (patch: Partial<Filters>) => void
}) {
  const [grain, setGrain] = useState<'day' | 'week' | 'month'>('week')
  const [by, setBy] = useState<'date' | 'status' | 'plate' | 'client'>(section === 'mantenimiento' || section === 'eficiencia' ? 'plate' : 'date')
  const [chartMetric, setChartMetric] = useState('count')
  const [sort, setSort] = useState('date')
  const [desc, setDesc] = useState(true)
  const [page, setPage] = useState(0)
  const [detail, setDetail] = useState<AnalysisRow | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const valueKeys = [...new Set(data.rows.flatMap(r => Object.keys(r.values)))]
  const series = useMemo(() => groups(data.rows, by, grain, chartMetric), [data.rows, by, grain, chartMetric])
  const sorted = useMemo(() => [...data.rows].sort((a, b) => {
    const va = sort in a.values ? a.values[sort] : a[sort as keyof AnalysisRow]
    const vb = sort in b.values ? b.values[sort] : b[sort as keyof AnalysisRow]
    if (va == null) return vb == null ? 0 : 1
    if (vb == null) return -1
    const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'es')
    return desc ? -cmp : cmp
  }), [data.rows, sort, desc])
  const pages = Math.max(1, Math.ceil(sorted.length / 25))
  const currentPage = Math.min(page, pages - 1)
  const exportData = async (kind: 'excel' | 'pdf') => {
    setExporting(true); setExportError('')
    try { await exportReport(kind, title, filters, data, previous) }
    catch { setExportError('No se pudo generar el archivo. Intente nuevamente.') }
    finally { setExporting(false) }
  }
  const toggle = (key: string) => { setSort(key); setDesc(sort === key ? !desc : false); setPage(0) }
  const sortHeader = (key: string, label: string) => <button onClick={() => toggle(key)} className="flex items-center gap-1 whitespace-nowrap">{label}{sort === key && (desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}</button>
  const drilldown = (label: string) => {
    if (by === 'status' && ['transporte', 'costos'].includes(section)) onFilter({ status: label })
    else if (by === 'plate') onFilter({ plate: label })
    else if (by === 'client' && section === 'transporte') onFilter({ client: label })
    else if (by === 'date' && section !== 'mantenimiento' && section !== 'eficiencia') {
      const from = label.length === 7 ? `${label}-01` : label
      const to = grain === 'month' ? new Date(Date.UTC(Number(label.slice(0, 4)), Number(label.slice(5, 7)), 0)).toISOString().slice(0, 10)
        : grain === 'week' ? new Date(new Date(`${from}T00:00:00Z`).getTime() + 6 * 86400000).toISOString().slice(0, 10) : from
      onFilter({ from: from < filters.from ? filters.from : from, to: to > filters.to ? filters.to : to })
    }
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <div><b className="text-slate-700">{data.source}</b> · {data.basis}{data.cutoff && ` · Corte: ${data.cutoff}`}</div>
        <div className="flex gap-2">
          <button disabled={blocked || exporting} onClick={() => exportData('excel')} className="flex min-h-11 items-center gap-1 rounded-lg border bg-white px-3 py-2 text-sm text-[#002855] disabled:opacity-40"><Download className="h-4 w-4" />Excel</button>
          <button disabled={blocked || exporting} onClick={() => exportData('pdf')} className="flex min-h-11 items-center gap-1 rounded-lg border bg-white px-3 py-2 text-sm text-[#002855] disabled:opacity-40"><FileText className="h-4 w-4" />PDF</button>
        </div>
      </div>
      {exportError && <p role="alert" className="text-sm text-red-700">{exportError}</p>}
      {data.note && <p className="rounded-lg border border-sky-100 bg-sky-50 p-3 text-xs text-sky-900">{data.note}</p>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">{data.metrics.map(m => <MetricCard key={m.key} metric={m} previous={previous?.metrics.find(x => x.key === m.key)} onClick={() => {
        if (m.key === 'incidents') onFilter({ incident: 'only' })
        document.getElementById('analytics-detail')?.scrollIntoView({ behavior: 'smooth' })
      }} />)}</div>
      {!data.rows.length ? <p className="rounded-xl border bg-white p-8 text-center text-sm text-slate-500">No hay registros visibles con este período y filtros. No significa que toda la operación esté en cero.</p> : <>
        <section className="rounded-xl border bg-white p-4">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-800">{chartMetric === 'count' ? 'Distribución de registros' : VALUE_LABELS[chartMetric]} · {data.rows.length} registros</h2>
            <div className="flex flex-wrap gap-2 text-xs"><select aria-label="Medida del gráfico" className="min-h-11 min-w-0 max-w-full rounded-lg border p-2 text-base sm:text-xs" value={chartMetric} onChange={e => setChartMetric(e.target.value)}><option value="count">Número de registros</option>{valueKeys.filter(k => !['availability', 'cost_km', 'cost_tkm', 'cost_hour', 'days'].includes(k)).map(k => <option key={k} value={k}>{VALUE_LABELS[k] || k}</option>)}</select><select aria-label="Agrupar gráfico" className="min-h-11 min-w-0 max-w-full rounded-lg border p-2 text-base sm:text-xs" value={by} onChange={e => setBy(e.target.value as typeof by)}>
              {section !== 'mantenimiento' && section !== 'eficiencia' && <option value="date">Fecha</option>}
              <option value="status">Estado</option>{section !== 'apt' && <option value="plate">Unidad / activo</option>}{section === 'transporte' && <option value="client">Cliente(s) del despacho</option>}
            </select>{by === 'date' && <select aria-label="Granularidad temporal" className="min-h-11 min-w-0 max-w-full rounded-lg border p-2 text-base sm:text-xs" value={grain} onChange={e => setGrain(e.target.value as typeof grain)}><option value="day">Día</option><option value="week">Semana</option><option value="month">Mes</option></select>}</div>
          </div>
          {series.length > 60 && <p className="mb-2 text-xs text-slate-500">El gráfico muestra las primeras 60 categorías; el detalle y la exportación incluyen todas.</p>}
          <div className="h-64 min-w-0"><ResponsiveContainer width="100%" height="100%"><BarChart data={series.slice(0, 60)}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="label" tick={{ fontSize: 10 }} /><YAxis allowDecimals={chartMetric !== 'count'} tick={{ fontSize: 11 }} /><Tooltip />
            <Bar dataKey="count" name={chartMetric === 'count' ? (section === 'apt' ? 'Capas de ingreso' : section === 'mantenimiento' || section === 'eficiencia' ? 'Activos' : 'Despachos') : VALUE_LABELS[chartMetric] || chartMetric} fill="#002855" radius={[4, 4, 0, 0]} onClick={d => drilldown(String((d.payload as { label?: string } | undefined)?.label || ''))} />
          </BarChart></ResponsiveContainer></div>
          <p className="mt-2 text-xs text-slate-500">Pulse una barra de fecha, unidad o estado para acotar el reporte cuando esa dimensión admita filtros.</p>
        </section>
        <section id="analytics-detail" className="overflow-hidden rounded-xl border bg-white">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b p-4"><h2 className="text-sm font-semibold text-slate-800">Detalle verificable</h2><span className="text-xs text-slate-500">{sorted.length} registros · pulse las columnas para ordenar</span></div>
          <div role="region" aria-label="Tabla de detalle analítico" tabIndex={0} className="max-w-full overflow-auto"><table className="w-full text-left text-xs"><thead className="bg-slate-50 text-slate-500"><tr>
            <th className="p-3">{sortHeader('code', 'Código')}</th><th className="p-3">{sortHeader('date', 'Fecha')}</th><th className="p-3">{sortHeader('status', 'Estado')}</th>
            {['transporte', 'costos'].includes(section) && <><th className="p-3">Unidad · conductor</th><th className="p-3">Contrato / ruta / sede</th></>}
            {valueKeys.map(k => <th key={k} className="p-3">{sortHeader(k, VALUE_LABELS[k] || k)}</th>)}<th className="p-3">Sustento</th>
          </tr></thead><tbody>{sorted.slice(currentPage * 25, currentPage * 25 + 25).map(r => <tr key={r.id} className="border-t hover:bg-slate-50">
            <td className="p-3 font-semibold text-[#002855]">{r.code}</td><td className="whitespace-nowrap p-3">{r.date || '—'}</td><td className="p-3">{section === 'transporte' || section === 'costos' ? dispatchStatusLabel(r.status) : r.status}</td>
            {['transporte', 'costos'].includes(section) && <><td className="p-3">{r.plate || '—'}<div className="text-slate-500">{r.driver || 'Sin conductor'}</div></td><td className="max-w-64 p-3">{r.contract || '—'}<div className="text-slate-500">{r.route || r.site}</div></td></>}
            {valueKeys.map(k => <td key={k} className="whitespace-nowrap p-3 text-right">{r.values[k] == null ? 'Sin dato' : r.values[k]?.toLocaleString('es-PE', { maximumFractionDigits: ['cost_km', 'cost_tkm', 'cost_hour'].includes(k) ? 4 : 2 })}</td>)}
            <td className="p-3"><button onClick={() => setDetail(r)} className="min-h-11 whitespace-nowrap font-semibold text-[#002855]">Ver detalle</button></td>
          </tr>)}</tbody></table></div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t p-3 text-xs"><button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="min-h-11 rounded border px-3 py-1 disabled:opacity-30 sm:min-h-0">Anterior</button><span>Página {currentPage + 1} de {pages}</span><button disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)} className="min-h-11 rounded border px-3 py-1 disabled:opacity-30 sm:min-h-0">Siguiente</button></div>
        </section>
      </>}
      {detail && <section aria-label="Sustento del registro" className="rounded-xl border-2 border-[#002855] bg-white p-5">
        <div className="flex items-center justify-between gap-2"><h3 className="min-w-0 break-words font-semibold text-[#002855]">{detail.code} · Sustento</h3><button aria-label="Cerrar detalle" onClick={() => setDetail(null)}><X className="h-5 w-5" /></button></div>
        <dl className="mt-4 grid gap-3 text-sm md:grid-cols-3">{Object.entries(detail.detail).map(([k, v]) => <div key={k} className="min-w-0"><dt className="text-xs text-slate-500">{k}</dt><dd className="min-w-0 break-all font-medium">{v == null || v === '' ? 'Sin dato' : String(v)}</dd></div>)}</dl>
        {detail.href && <Link href={detail.href} className="mt-4 inline-block text-sm font-semibold text-[#002855]">Abrir registro en su módulo operativo →</Link>}
        <p className="mt-3 text-xs text-slate-500">{filters.from} a {filters.to} · {data.source}</p>
      </section>}
    </div>
  )
}
