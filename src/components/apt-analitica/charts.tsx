'use client'

import { useState, type ReactNode } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Sankey, Scatter, ScatterChart, Tooltip,
  XAxis, YAxis, ZAxis } from 'recharts'
import { Table2, BarChart3 } from 'lucide-react'
import type { DayPoint } from '@/lib/apt-analitica/engine'
import type { Bucket, WeightedPoint } from '@/lib/apt-analitica/stats'
import { COLORS, ChartTip, Empty, fmtDate, fmtNum, fmtPct } from './ui'

// Gráficos de la analítica: una sola unidad por gráfico, un solo eje de valores, hover con tooltip y vista de tabla.

const shortDate = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`
const axisProps = { tick: { fontSize: 11, fill: COLORS.axis }, tickLine: false, axisLine: { stroke: COLORS.grid } }
const compact = (v: number) => Math.abs(v) >= 1e6 ? `${fmtNum(v / 1e6, 1)} M` : Math.abs(v) >= 1e4 ? `${fmtNum(v / 1e3, 0)} mil` : fmtNum(v, 0)

/** Marco con alternancia gráfico / tabla (la tabla es la alternativa accesible y exportable) */
export function ChartFrame({ chart, table, height = 260, empty }: { chart: ReactNode; table: { head: string[]; rows: Array<Array<string | number>> }; height?: number; empty?: string | null }) {
  const [asTable, setAsTable] = useState(false)
  if (empty) return <Empty title={empty} />
  return (
    <div>
      <div className="mb-1 flex justify-end">
        <button type="button" onClick={() => setAsTable(t => !t)} aria-pressed={asTable}
          className="flex items-center gap-1 rounded border border-slate-200 px-2 py-0.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-50">
          {asTable ? <><BarChart3 className="h-3 w-3" aria-hidden />Ver gráfico</> : <><Table2 className="h-3 w-3" aria-hidden />Ver tabla</>}
        </button>
      </div>
      {asTable
        ? <div className="max-h-80 overflow-auto rounded border border-slate-200"><table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-50"><tr>{table.head.map(h => <th key={h} className="px-2 py-1 text-left font-semibold text-slate-700">{h}</th>)}</tr></thead>
            <tbody>{table.rows.map((r, i) => <tr key={i} className="border-t border-slate-100">{r.map((c, j) => <td key={j} className={`px-2 py-1 ${typeof c === 'number' ? 'text-right tabular-nums' : ''}`}>{typeof c === 'number' ? fmtNum(c) : c}</td>)}</tr>)}</tbody>
          </table></div>
        : <div style={{ height }} className="w-full min-w-0">{chart}</div>}
    </div>
  )
}

export function FlowBars({ data, unit, labels = ['Entradas', 'Salidas'] }: { data: Array<{ fecha: string; entradas: number; salidas: number }>; unit: string | null; labels?: [string, string] }) {
  return <ChartFrame empty={data.length ? null : 'Sin movimientos en el período'}
    table={{ head: ['Fecha', `${labels[0]} (${unit})`, `${labels[1]} (${unit})`, 'Variación'], rows: data.map(d => [fmtDate(d.fecha), d.entradas, d.salidas, d.entradas - d.salidas]) }}
    chart={<ResponsiveContainer><BarChart data={data} barGap={2} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
      <CartesianGrid vertical={false} stroke={COLORS.grid} />
      <XAxis dataKey="fecha" tickFormatter={shortDate} {...axisProps} minTickGap={12} />
      <YAxis tickFormatter={compact} {...axisProps} width={56} />
      <Tooltip content={<ChartTip unit={unit} labelFmt={fmtDate} />} cursor={{ fill: '#f1f5f9' }} />
      <Legend wrapperStyle={{ fontSize: 12 }} />
      <Bar dataKey="entradas" name={labels[0]} fill={COLORS.entradas} radius={[4, 4, 0, 0]} maxBarSize={28} />
      <Bar dataKey="salidas" name={labels[1]} fill={COLORS.salidas} radius={[4, 4, 0, 0]} maxBarSize={28} />
    </BarChart></ResponsiveContainer>} />
}

export function CumLine({ data, unit }: { data: DayPoint[]; unit: string | null }) {
  return <ChartFrame empty={data.length ? null : 'Sin movimientos en el período'}
    table={{ head: ['Fecha', `Variación del día (${unit})`, 'Acumulada'], rows: data.map(d => [fmtDate(d.fecha), d.neta, d.acumulada]) }}
    chart={<ResponsiveContainer><LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
      <CartesianGrid vertical={false} stroke={COLORS.grid} />
      <XAxis dataKey="fecha" tickFormatter={shortDate} {...axisProps} minTickGap={12} />
      <YAxis tickFormatter={compact} {...axisProps} width={56} />
      <ReferenceLine y={0} stroke="#94a3b8" />
      <Tooltip content={<ChartTip unit={unit} labelFmt={fmtDate} />} />
      <Line type="monotone" dataKey="acumulada" name="Variación acumulada" stroke={COLORS.neta} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
    </LineChart></ResponsiveContainer>} />
}

/** Barras apiladas por clase de movimiento (entradas y salidas en pilas separadas) */
export function ClassBars({ data, series, unit }: { data: Array<Record<string, number | string>>; series: Array<{ key: string; label: string; color: string; stack: 'E' | 'S' }>; unit: string | null }) {
  return <ChartFrame empty={data.length ? null : 'Sin movimientos en el período'}
    table={{ head: ['Fecha', ...series.map(s => `${s.label} (${unit})`)], rows: data.map(d => [fmtDate(String(d.fecha)), ...series.map(s => Number(d[s.key] ?? 0))]) }}
    chart={<ResponsiveContainer><BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
      <CartesianGrid vertical={false} stroke={COLORS.grid} />
      <XAxis dataKey="fecha" tickFormatter={shortDate} {...axisProps} minTickGap={12} />
      <YAxis tickFormatter={compact} {...axisProps} width={56} />
      <Tooltip content={<ChartTip unit={unit} labelFmt={fmtDate} />} cursor={{ fill: '#f1f5f9' }} />
      <Legend wrapperStyle={{ fontSize: 12 }} />
      {series.map((s, i) => <Bar key={s.key} dataKey={s.key} name={s.label} stackId={s.stack} fill={s.color} stroke="#fff" strokeWidth={1}
        radius={series.slice(i + 1).some(x => x.stack === s.stack) ? 0 : [4, 4, 0, 0]} maxBarSize={30} />)}
    </BarChart></ResponsiveContainer>} />
}

export function BucketBars({ buckets, unit, label = 'Cantidad', color = COLORS.entradas }: { buckets: Bucket[]; unit: string | null; label?: string; color?: string }) {
  const total = buckets.reduce((a, b) => a + b.weight, 0)
  return <ChartFrame empty={total > 0 ? null : 'Sin cantidades para agrupar'}
    table={{ head: ['Rango', `${label} (${unit})`, '% del total', 'Registros'], rows: buckets.map(b => [b.label, b.weight, fmtPct(total ? b.weight / total : null), b.count]) }}
    chart={<ResponsiveContainer><BarChart data={buckets.map(b => ({ ...b, share: total ? b.weight / total : 0 }))} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
      <CartesianGrid vertical={false} stroke={COLORS.grid} />
      <XAxis dataKey="label" {...axisProps} />
      <YAxis tickFormatter={compact} {...axisProps} width={56} />
      <Tooltip content={<ChartTip unit={unit} />} cursor={{ fill: '#f1f5f9' }} />
      <Bar dataKey="weight" name={label} fill={color} radius={[4, 4, 0, 0]} maxBarSize={48}
        label={{ position: 'top', fontSize: 11, fill: '#334155', formatter: (v: unknown) => total ? fmtPct(Number(v) / total, 0) : '' }} />
    </BarChart></ResponsiveContainer>} />
}

/** Histograma ponderado por cantidad (días 0…max; el último rango agrupa el resto) */
export function DwellHistogram({ points, unit, max = 20 }: { points: WeightedPoint[]; unit: string | null; max?: number }) {
  const bins = Array.from({ length: max + 2 }, (_, i) => ({ label: i <= max ? `${i}` : `>${max}`, weight: 0 }))
  for (const p of points) bins[Math.min(Math.max(0, Math.round(p.value)), max + 1)].weight += p.weight
  while (bins.length > 1 && bins[bins.length - 1].weight === 0 && bins[bins.length - 2].weight === 0) bins.pop()
  return <ChartFrame empty={points.length ? null : 'Sin salidas enlazadas'}
    table={{ head: ['Días en bodega', `Cantidad (${unit})`], rows: bins.map(b => [b.label, b.weight]) }}
    chart={<ResponsiveContainer><BarChart data={bins} barCategoryGap={2} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
      <CartesianGrid vertical={false} stroke={COLORS.grid} />
      <XAxis dataKey="label" {...axisProps} label={{ value: 'días calendario', position: 'insideBottomRight', offset: -2, fontSize: 11, fill: COLORS.axis }} />
      <YAxis tickFormatter={compact} {...axisProps} width={56} />
      <Tooltip content={<ChartTip unit={unit} labelFmt={l => `${l} día(s)`} />} cursor={{ fill: '#f1f5f9' }} />
      <Bar dataKey="weight" name="Cantidad que salió" fill={COLORS.salidas} radius={[4, 4, 0, 0]} />
    </BarChart></ResponsiveContainer>} />
}

/** Pareto horizontal: barras ordenadas y % acumulado como etiqueta (sin segundo eje) */
export function ParetoBars({ rows, unit, top = 15, valueLabel = 'Cantidad' }: { rows: Array<{ label: string; value: number; share: number; cumShare: number }>; unit: string | null; top?: number; valueLabel?: string }) {
  const shown = rows.slice(0, top).map(r => ({ ...r, cumLabel: `${fmtPct(r.cumShare, 0)} acum.` }))
  const h = Math.max(160, shown.length * 26 + 30)
  return <ChartFrame height={h} empty={rows.length ? null : 'Sin cantidades para ordenar'}
    table={{ head: ['Elemento', `${valueLabel} (${unit})`, '% del total', '% acumulado'], rows: rows.map(r => [r.label, r.value, fmtPct(r.share), fmtPct(r.cumShare)]) }}
    chart={<ResponsiveContainer><BarChart data={shown} layout="vertical" margin={{ top: 4, right: 70, left: 4, bottom: 4 }}>
      <CartesianGrid horizontal={false} stroke={COLORS.grid} />
      <XAxis type="number" tickFormatter={compact} {...axisProps} />
      <YAxis type="category" dataKey="label" width={170} {...axisProps} tickFormatter={(v: string) => v.length > 26 ? `${v.slice(0, 25)}…` : v} />
      <Tooltip content={<ChartTip unit={unit} />} cursor={{ fill: '#f1f5f9' }} />
      <Bar dataKey="value" name={valueLabel} fill={COLORS.entradas} radius={[0, 4, 4, 0]} maxBarSize={18}>
        <LabelList dataKey="cumLabel" position="right" fontSize={10} fill="#334155" />
      </Bar>
    </BarChart></ResponsiveContainer>} />
}

/** Mapa de calor: filas × rangos de antigüedad, intensidad = cantidad (una sola tonalidad) */
export function Heatmap({ rows, cols, unit, onCell }: { rows: Array<{ label: string; values: number[] }>; cols: string[]; unit: string | null; onCell?: (row: number, col: number) => void }) {
  const max = Math.max(0, ...rows.flatMap(r => r.values))
  if (!rows.length || max <= 0) return <Empty title="Sin existencias abiertas" />
  const tone = (v: number) => {
    if (v <= 0) return { bg: '#f8fafc', fg: '#94a3b8' }
    const i = Math.min(COLORS.seq.length - 1, Math.floor((v / max) * COLORS.seq.length))
    return { bg: COLORS.seq[i], fg: i >= 2 ? '#fff' : '#0f172a' }
  }
  return <div className="overflow-x-auto">
    <table className="w-full border-separate border-spacing-0.5 text-[11px]" aria-label={`Mapa de calor de antigüedad (${unit})`}>
      <thead><tr><th className="px-1 text-left font-semibold text-slate-600">Producto</th>{cols.map(c => <th key={c} className="px-1 font-semibold text-slate-600">{c}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={r.label}>
        <th scope="row" className="max-w-[14rem] truncate px-1 text-left font-medium text-slate-700" title={r.label}>{r.label}</th>
        {r.values.map((v, j) => { const t = tone(v); return <td key={j} className="p-0">
          <button type="button" disabled={!onCell || v <= 0} onClick={() => onCell?.(i, j)} title={`${r.label} · ${cols[j]}: ${fmtNum(v)} ${unit}`}
            className="h-7 w-full min-w-[3.5rem] rounded px-1 text-right tabular-nums" style={{ background: t.bg, color: t.fg }}>{v > 0 ? compact(v) : '·'}</button></td> })}
      </tr>)}</tbody>
    </table>
  </div>
}

export function OpenScatter({ points, unit, onPoint }: { points: Array<{ age: number; qty: number; label: string; id: number }>; unit: string | null; onPoint?: (id: number) => void }) {
  return <ChartFrame empty={points.length ? null : 'Sin existencias abiertas'}
    table={{ head: ['Lote / producto', 'Antigüedad (días)', `Cantidad abierta (${unit})`], rows: points.map(p => [p.label, p.age, p.qty]) }}
    chart={<ResponsiveContainer><ScatterChart margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
      <CartesianGrid stroke={COLORS.grid} />
      <XAxis type="number" dataKey="age" name="Antigüedad" unit=" d" {...axisProps} />
      <YAxis type="number" dataKey="qty" name="Cantidad" tickFormatter={compact} {...axisProps} width={56} />
      <ZAxis range={[60, 60]} />
      <Tooltip cursor={{ strokeDasharray: '3 3' }} content={({ active, payload }) => {
        const p = active ? payload?.[0]?.payload as { label: string; age: number; qty: number } | undefined : undefined
        return p ? <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg"><p className="font-bold">{p.label}</p><p>{p.age} día(s) · {fmtNum(p.qty)} {unit}</p></div> : null
      }} />
      <Scatter data={points} fill={COLORS.entradas} stroke="#fff" strokeWidth={2} onClick={(d: unknown) => { const id = (d as { payload?: { id?: number } })?.payload?.id; if (id !== undefined) onPoint?.(id) }} />
    </ScatterChart></ResponsiveContainer>} />
}

export interface FlowNode { name: string }
export interface FlowLink { source: number; target: number; value: number; status: 'CONCILIADA' | 'PENDIENTE' }

/** Diagrama de flujos entre bodegas (traspasos). Los vínculos sin conciliar se dibujan punteados. */
export function FlowSankey({ nodes, links, unit }: { nodes: FlowNode[]; links: FlowLink[]; unit: string | null }) {
  const valid = links.filter(l => l.value > 0 && l.source !== l.target)
  return <ChartFrame height={Math.max(220, nodes.length * 34)} empty={valid.length ? null : 'Sin traspasos en el alcance'}
    table={{ head: ['Origen', 'Destino', `Cantidad (${unit})`, 'Estado'], rows: valid.map(l => [nodes[l.source].name, nodes[l.target].name, l.value, l.status === 'CONCILIADA' ? 'Conciliado' : 'Pendiente / con diferencia']) }}
    chart={<ResponsiveContainer><Sankey data={{ nodes, links: valid }} nodePadding={20} nodeWidth={10} margin={{ left: 8, right: 180, top: 8, bottom: 8 }}
      link={p => { const st = (p.payload as unknown as FlowLink).status; return (
        <path d={`M${p.sourceX},${p.sourceY}C${p.sourceControlX},${p.sourceY} ${p.targetControlX},${p.targetY} ${p.targetX},${p.targetY}`} fill="none"
          stroke={st === 'CONCILIADA' ? COLORS.entradas : COLORS.salidas} strokeOpacity={0.35} strokeWidth={Math.max(1, p.linkWidth)}
          strokeDasharray={st === 'CONCILIADA' ? undefined : '6 4'} />) }}
      node={p => { const n = p.payload as unknown as FlowNode & { value?: number }; return (
        <g><rect x={p.x} y={p.y} width={p.width} height={p.height} fill="#002855" rx={2} />
          <text x={p.x + p.width + 6} y={p.y + p.height / 2} dy={4} fontSize={11} fill="#0f172a">{n.name} · {compact(n.value ?? 0)}</text></g>) }}>
      <Tooltip content={({ active, payload }) => {
        const d = active ? payload?.[0]?.payload as { payload?: { source?: FlowNode; target?: FlowNode; value?: number; status?: string } } | undefined : undefined
        const l = d?.payload
        return l?.source ? <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg"><p className="font-bold">{l.source.name} → {l.target?.name}</p>
          <p>{fmtNum(l.value)} {unit} · {l.status === 'CONCILIADA' ? 'conciliado' : 'pendiente o con diferencia'}</p></div> : null
      }} />
    </Sankey></ResponsiveContainer>} />
}

export { Cell }
