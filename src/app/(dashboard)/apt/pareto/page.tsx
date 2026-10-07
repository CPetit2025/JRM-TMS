'use client'
import { DataTable } from '@/components/ui/data-table'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Bar, Cell, ComposedChart, CartesianGrid, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { aptApi } from '@/lib/apt/api'
import { APT_COLORS, fmtInt, fmtPct, fmtTn } from '@/lib/apt/format'
import { exportAptXlsx } from '@/lib/apt/export'
import { loteHref, useAptFilters } from '@/lib/apt/useAptFilters'
import type { AptDim, AptPareto } from '@/lib/apt/types'
import { ChartCard, DiasBadge, EmptyState, ErrorBlock, InlineBar, KpiCard, LoadingBlock } from '@/components/apt/ui'
import { ExportButton, Segmented, TooltipBox, truncate, useAsyncData } from '@/components/apt/PphShared'

// Pareto / ABC del inventario en APT: qué pocos NumRel, productos, glosas o familias concentran el volumen o el TN×Días.
// Clase A hasta el 80 % acumulado, B hasta el 95 %, C el resto (calculado en apt_pareto).

type Metric = 'tn' | 'txd'
type Item = AptPareto['items'][number]
const DIMS: Array<{ value: AptDim; label: string }> = [
  { value: 'lote', label: 'NumRel' },
  { value: 'producto', label: 'Producto' },
  { value: 'glosa', label: 'Glosa' },
  { value: 'familia', label: 'Familia' },
]
const DIM_PLURAL: Record<AptDim, string> = { lote: 'NumRel', producto: 'productos', glosa: 'glosas', familia: 'familias' }
const METRICS: Array<{ value: Metric; label: string }> = [
  { value: 'tn', label: 'TN almacenadas' },
  { value: 'txd', label: 'TN×Días' },
]
const TOPS = [20, 40, 80, 150]
const CLASE_COLOR = { A: APT_COLORS.navy, B: '#60a5fa', C: '#cbd5e1' } as const
const CLASE_CLS = {
  A: 'bg-[#002855] text-white border-[#002855]',
  B: 'bg-blue-50 text-blue-700 border-blue-200',
  C: 'bg-slate-50 text-slate-600 border-slate-200',
} as const

export default function AptParetoPage() {
  const router = useRouter()
  const { filters, patchFilters, filterKey } = useAptFilters()
  const [dim, setDim] = useState<AptDim>('lote')
  const [metric, setMetric] = useState<Metric>('tn')
  const [top, setTop] = useState(40)
  const [exporting, setExporting] = useState(false)
  const q = useAsyncData(`pareto|${dim}|${metric}|${filterKey}`, () => aptApi.pareto(filters, dim, metric))
  const d = q.data

  const fmtV = (v: number | null | undefined) => (metric === 'tn' ? `${fmtTn(v)} TN` : fmtInt(v))
  const unit = metric === 'tn' ? 'TN' : 'TN×Días'

  const clases = useMemo(() => {
    if (!d) return null
    const acc = { A: { n: 0, pct: 0, v: 0 }, B: { n: 0, pct: 0, v: 0 }, C: { n: 0, pct: 0, v: 0 } }
    d.items.forEach(i => { acc[i.clase].n++; acc[i.clase].pct += i.pct; acc[i.clase].v += i.valor })
    // apt_pareto devuelve hasta 500 elementos: la cola (clase C) se completa con los totales
    acc.C.n = Math.max(0, d.items_total - acc.A.n - acc.B.n)
    acc.C.v = Math.max(0, d.total - acc.A.v - acc.B.v)
    acc.C.pct = Math.max(0, 100 - acc.A.pct - acc.B.pct)
    return acc
  }, [d])

  const chartData = useMemo(() => (d?.items || []).slice(0, top), [d, top])

  const open = (it: Item) => {
    if (dim === 'lote') { router.push(loteHref(it.clave, filters)); return }
    patchFilters(dim === 'producto' ? { productos: [it.clave] } : dim === 'glosa' ? { glosas: [it.clave] } : { familias: [it.clave] })
    toast.success(`Filtro aplicado: ${it.clave}`)
  }

  const exportar = () => {
    if (!d) return
    setExporting(true)
    try {
      exportAptXlsx(`APT_Pareto_${DIM_PLURAL[dim]}_${metric}`, {
        Pareto: d.items.map(i => ({
          Rank: i.rank, [DIMS.find(x => x.value === dim)!.label]: i.clave, Glosa: i.etiqueta,
          [metric === 'tn' ? 'TN almacenadas' : 'TN×Días']: i.valor, '%': i.pct, '% acumulado': i.pct_acum, Clase: i.clase,
          'Días (saldo más antiguo)': i.dias,
        })),
        Resumen: [
          { Concepto: 'Total', Valor: d.total },
          { Concepto: `Elementos con saldo`, Valor: d.items_total },
          { Concepto: 'Elementos que concentran el 80 %', Valor: d.items_80 },
          { Concepto: '% de elementos que concentran el 80 %', Valor: d.pct_items_80 },
          ...(['A', 'B', 'C'] as const).map(c => ({ Concepto: `Clase ${c} (elementos / % del valor)`, Valor: `${clases?.[c].n} / ${clases?.[c].pct.toFixed(1)} %` })),
        ],
      })
    } finally {
      setExporting(false)
    }
  }

  const plural = DIM_PLURAL[dim]
  const pocos = d?.pct_items_80 !== null && d?.pct_items_80 !== undefined && d.pct_items_80 <= 30

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Segmented label="Dimensión" value={dim} options={DIMS} onChange={setDim} />
        <Segmented label="Métrica" value={metric} options={METRICS} onChange={setMetric} />
      </div>

      {q.error && !d ? <ErrorBlock message={q.error} onRetry={q.reload} /> : !d ? <LoadingBlock /> : d.items_total === 0 ? (
        <EmptyState title="Aún no hay movimientos: cargue ENTRADA y SALIDA">No hay saldo en APT para los filtros seleccionados.</EmptyState>
      ) : (
        <div className={`space-y-4 transition-opacity ${q.loading ? 'opacity-60' : ''}`}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <div className="col-span-2 lg:col-span-1">
              <KpiCard label="Concentración del 80 %" tone={pocos ? 'crit' : 'navy'}
                value={<>{fmtInt(d.items_80)} <span className="text-base font-semibold text-slate-400">de {fmtInt(d.items_total)}</span></>}
                hint={<>{plural} ({fmtPct(d.pct_items_80)}) concentran el 80 % de {metric === 'tn' ? 'las TN almacenadas' : 'los TN×Días'}</>} />
            </div>
            <KpiCard label={metric === 'tn' ? 'Total almacenado' : 'Total TN×Días'} value={metric === 'tn' ? fmtTn(d.total) : fmtInt(d.total)}
              unit={metric === 'tn' ? 'TN' : undefined} hint={`${fmtInt(d.items_total)} ${plural} con saldo`} />
            {(['A', 'B', 'C'] as const).map(c => (
              <KpiCard key={c} label={`Clase ${c}`} tone={c === 'A' ? 'navy' : 'default'}
                value={<>{fmtInt(clases?.[c].n)} <span className="text-sm font-semibold text-slate-400">{plural}</span></>}
                hint={<>
                  <span className="font-semibold text-slate-700">{fmtPct(clases?.[c].pct)}</span> del valor ·{' '}
                  {fmtPct(d.items_total ? (100 * (clases?.[c].n || 0)) / d.items_total : null)} de los {plural}
                  <span className="mt-1 block"><InlineBar value={clases?.[c].pct || 0} max={100} color={CLASE_COLOR[c] === '#cbd5e1' ? '#94a3b8' : CLASE_COLOR[c]} /></span>
                </>} />
            ))}
          </div>

          <ChartCard title={`Pareto de ${plural} por ${metric === 'tn' ? 'TN almacenadas' : 'TN×Días'}`}
            subtitle={`Barras: ${unit} de cada elemento (color por clase ABC) · Línea: % acumulado (eje derecho) · Mostrando ${fmtInt(chartData.length)} de ${fmtInt(d.items_total)}`}
            info="Ordena de mayor a menor y acumula. La línea roja punteada marca el 80 %: lo que está a su izquierda es la clase A. Clic en una barra para abrir el lote o filtrar."
            actions={
              <label className="flex items-center gap-1.5 text-xs text-slate-500">Mostrar
                <select value={top} onChange={e => setTop(Number(e.target.value))} aria-label="Cantidad de elementos en el gráfico"
                  className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-700 outline-none focus:border-[#002855]">
                  {TOPS.map(n => <option key={n} value={n}>Top {n}</option>)}
                </select>
              </label>
            }>
            <div className="overflow-x-auto">
              <div style={{ minWidth: Math.max(640, chartData.length * 16) }}>
                <ResponsiveContainer width="100%" height={380}>
                  <ComposedChart data={chartData} margin={{ top: 10, right: 8, bottom: 0, left: 4 }} barCategoryGap={chartData.length > 60 ? 1 : 3}>
                    <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="clave" axisLine={false} tickLine={false} interval={chartData.length > 60 ? 'preserveStartEnd' : 0}
                      angle={-55} textAnchor="end" height={dim === 'lote' ? 64 : 90} tick={{ fontSize: 10, fill: '#64748b' }}
                      tickFormatter={(v: string) => truncate(v, dim === 'lote' ? 12 : 16)} />
                    <YAxis yAxisId="v" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: '#64748b' }} width={56}
                      tickFormatter={(v: number) => fmtInt(v)} />
                    <YAxis yAxisId="p" orientation="right" domain={[0, 100]} ticks={[0, 20, 40, 60, 80, 100]} axisLine={false} tickLine={false}
                      tick={{ fontSize: 11, fill: '#64748b' }} tickFormatter={(v: number) => `${v} %`} width={44} />
                    <ReferenceLine yAxisId="p" y={80} stroke={APT_COLORS.red} strokeDasharray="5 4"
                      label={{ value: '80 %', position: 'insideTopLeft', fill: APT_COLORS.red, fontSize: 11, fontWeight: 700 }} />
                    <Tooltip cursor={{ fill: '#f1f5f9' }} content={({ active, payload }) => {
                      const it = active && (payload?.[0]?.payload as Item | undefined)
                      if (!it) return null
                      return <TooltipBox title={`#${it.rank} · ${it.clave}`} subtitle={dim === 'glosa' || dim === 'familia' ? null : it.etiqueta} rows={[
                        [unit, fmtV(it.valor)], ['% del total', fmtPct(it.pct)], ['% acumulado', fmtPct(it.pct_acum)],
                        ['Clase', it.clase], ['Días saldo más antiguo', it.dias === null ? '—' : `${fmtInt(it.dias)} d`],
                      ]} />
                    }} />
                    <Bar yAxisId="v" dataKey="valor" radius={[4, 4, 0, 0]} maxBarSize={28} animationDuration={500} cursor="pointer"
                      onClick={(x) => { const it = (x as unknown as { payload?: Item }).payload; if (it) open(it) }}>
                      {chartData.map(it => <Cell key={it.clave} fill={CLASE_COLOR[it.clase]} />)}
                    </Bar>
                    <Line yAxisId="p" type="monotone" dataKey="pct_acum" stroke={APT_COLORS.red} strokeWidth={2} dot={false}
                      activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} animationDuration={500} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px] text-slate-500">
              {(['A', 'B', 'C'] as const).map(c => (
                <span key={c} className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: CLASE_COLOR[c] }} />
                  Clase {c} {c === 'A' ? '(hasta 80 %)' : c === 'B' ? '(80–95 %)' : '(último 5 %)'}
                </span>
              ))}
              <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded" style={{ background: APT_COLORS.red }} /> % acumulado</span>
            </div>
          </ChartCard>

          <ChartCard title="Tabla ABC"
            subtitle={`${fmtInt(d.items.length)} ${plural}${d.items.length < d.items_total ? ` (primeros ${fmtInt(d.items.length)} de ${fmtInt(d.items_total)}; el resto es clase C)` : ''} · clic para ${dim === 'lote' ? 'abrir la ficha del lote' : 'filtrar el módulo'}`}
            actions={<ExportButton onClick={exportar} busy={exporting} />} bodyClassName="p-0">
            <div className="max-h-[560px] overflow-auto">
              <DataTable className="w-full min-w-[820px] text-sm">
                <thead>
                  <tr className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
                    {['#', DIMS.find(x => x.value === dim)!.label, dim === 'producto' || dim === 'lote' ? 'Glosa principal' : '', unit, '% del total', '% acum.', 'Clase', 'Días'].map((h, i) => (
                      <th key={i} className={`sticky top-0 z-10 whitespace-nowrap border-b border-slate-200 bg-slate-50 px-3 py-2 ${
                        i >= 3 && i <= 5 ? 'text-right' : i >= 6 ? 'text-center' : 'text-left'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {d.items.map((it, idx) => {
                    const corte = d.items_80 !== null && it.rank === d.items_80
                    return (
                      <tr key={it.clave} onClick={() => open(it)}
                        className={`cursor-pointer hover:bg-[#002855]/[0.03] ${corte ? 'border-b-2 border-b-red-300' : ''} ${idx % 2 ? 'bg-slate-50/40' : ''}`}>
                        <td className="px-3 py-1.5 tabular-nums text-slate-400">{it.rank}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 font-semibold text-[#002855]">{it.clave}</td>
                        <td className="max-w-[360px] truncate px-3 py-1.5 text-xs text-slate-500" title={it.etiqueta || ''}>
                          {dim === 'producto' || dim === 'lote' ? it.etiqueta : ''}
                        </td>
                        <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{metric === 'tn' ? fmtTn(it.valor) : fmtInt(it.valor)}</td>
                        <td className="w-32 px-3 py-1.5 text-right">
                          <p className="tabular-nums">{fmtPct(it.pct)}</p>
                          <InlineBar value={it.pct} max={d.items[0]?.pct || 1} color={CLASE_COLOR[it.clase] === '#cbd5e1' ? '#94a3b8' : CLASE_COLOR[it.clase]} />
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-slate-600">{fmtPct(it.pct_acum)}</td>
                        <td className="px-3 py-1.5 text-center">
                          <span className={`inline-flex h-5 w-5 items-center justify-center rounded border text-[11px] font-black ${CLASE_CLS[it.clase]}`}>{it.clase}</span>
                        </td>
                        <td className="px-3 py-1.5 text-center"><DiasBadge dias={it.dias} /></td>
                      </tr>
                    )
                  })}
                </tbody>
              </DataTable>
            </div>
          </ChartCard>
        </div>
      )}
    </div>
  )
}
