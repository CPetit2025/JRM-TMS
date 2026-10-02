'use client'

import type { ReactNode } from 'react'
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Line, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { APT_COLORS, ESTADO_STYLE, agingColor, fmtDec1, fmtDias, fmtPct, fmtTn } from '@/lib/apt/format'
import type {
  AptAgingBucket, AptEstado, AptEstadoRow, AptFamiliaTop, AptGrain, AptLoteTop, AptProductoTop, AptTrendPoint,
} from '@/lib/apt/types'

// Gráficos del dashboard APT (recharts). Formato peruano en ejes y tooltips; clic en barras = filtrar o abrir el lote.

const AXIS_TICK = { fontSize: 11, fill: '#64748b' }
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
const nf0 = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 0 })
const nf1 = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 1 })

// Eje compacto: 4 500 → "4,5 mil"; 12 → "12"; 0,4 → "0,4"
export const fmtAxis = (v: number) =>
  Math.abs(v) >= 10000 ? `${nf0.format(v / 1000)} mil` : Math.abs(v) >= 1000 ? `${nf1.format(v / 1000)} mil` : Math.abs(v) >= 10 ? nf0.format(v) : nf1.format(v)

export const short = (s: string | null | undefined, n: number) => (!s ? '—' : s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

export function periodoLabel(p: string, grain: AptGrain) {
  const [y, m, d] = p.slice(0, 10).split('-')
  if (grain === 'mes') return `${MESES[Number(m) - 1]} ${y.slice(2)}`
  return `${d}/${m}`
}

// Índice del rango de aging al que pertenecen unos días (para colorear coherente con el gráfico de aging)
export function rangoIndex(dias: number | null | undefined, aging: AptAgingBucket[]) {
  if (dias === null || dias === undefined || !aging.length) return 0
  let idx = 0
  aging.forEach((b, i) => { if (dias >= b.desde) idx = i })
  return idx
}
export const diasColor = (dias: number | null | undefined, aging: AptAgingBucket[]) =>
  agingColor(rangoIndex(dias, aging), Math.max(aging.length, 2))

// Tarjeta de tooltip común
function TipBox({ title, subtitle, rows }: { title: ReactNode; subtitle?: ReactNode; rows: Array<[string, ReactNode, string?]> }) {
  return (
    <div className="max-w-xs rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg">
      <p className="font-bold text-slate-800">{title}</p>
      {subtitle && <p className="mt-0.5 leading-snug text-slate-500">{subtitle}</p>}
      <div className="mt-1.5 space-y-0.5">
        {rows.map(([k, v, color]) => (
          <div key={k} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-slate-500">
              {color && <span className="h-2 w-2 rounded-sm" style={{ background: color }} />}{k}
            </span>
            <span className="font-semibold tabular-nums text-slate-800">{v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

type TipArgs = { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }
function tipRow<T>(a: TipArgs): T | null {
  return a.active && a.payload?.length ? (a.payload[0].payload as T) : null
}

// 1. TN por rango de aging (columnas)
export function AgingColumns({ data, onSelect, active }: { data: AptAgingBucket[]; onSelect: (rango: string) => void; active?: string[] }) {
  const n = data.length
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} margin={{ top: 34, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="rango" tick={AXIS_TICK} axisLine={false} tickLine={false} interval={0} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={fmtAxis} width={44} />
        <Tooltip cursor={{ fill: '#f1f5f9' }} content={a => {
          const r = tipRow<AptAgingBucket>(a)
          return r && <TipBox title={r.rango} rows={[
            ['TN en APT', fmtTn(r.tn)], ['% de la TN', fmtPct(r.pct)], ['Lotes', fmtDias(r.lotes)], ['Capas', fmtDias(r.capas)], ['TN×Días', fmtTn(r.tn_dias)],
          ]} />
        }} />
        <Bar dataKey="tn" radius={[4, 4, 0, 0]} cursor="pointer" maxBarSize={64} animationDuration={600}
          onClick={(_, i) => data[i] && onSelect(data[i].rango)}>
          {data.map((d, i) => (
            <Cell key={d.rango} fill={agingColor(i, n)} fillOpacity={active?.length && !active.includes(d.rango) ? 0.35 : 1} />
          ))}
          <LabelList dataKey="tn" content={p => {
            const i = Number(p.index), d = data[i]
            if (!d) return null
            const x = Number(p.x) + Number(p.width) / 2, y = Number(p.y)
            return (
              <g>
                <text x={x} y={y - 18} textAnchor="middle" fontSize={11} fontWeight={700} fill="#1e293b">{fmtDec1(d.tn)}</text>
                <text x={x} y={y - 6} textAnchor="middle" fontSize={10} fill="#64748b">{fmtPct(d.pct)}</text>
              </g>
            )
          }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// 2 y 3. Ranking horizontal de lotes (TN o TN×Días)
export function LoteBars({ data, metric, aging, onSelect }: {
  data: AptLoteTop[]; metric: 'tn_saldo' | 'tn_dias'; aging: AptAgingBucket[]; onSelect: (lote: string) => void
}) {
  const rows = [...data].sort((a, b) => b[metric] - a[metric])
  return (
    <ResponsiveContainer width="100%" height={Math.max(220, rows.length * 30 + 20)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 56, left: 0, bottom: 0 }} barCategoryGap={5}>
        <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={fmtAxis} />
        <YAxis type="category" dataKey="lote" tick={{ ...AXIS_TICK, fontWeight: 600, fill: '#334155' }} axisLine={false} tickLine={false} width={84} interval={0} />
        <Tooltip cursor={{ fill: '#f1f5f9' }} content={a => {
          const r = tipRow<AptLoteTop>(a)
          return r && <TipBox title={`NumRel ${r.lote}`} subtitle={short(r.glosa, 90)} rows={[
            ['Saldo TN', fmtTn(r.tn_saldo)], ['TN×Días', fmtTn(r.tn_dias)], ['Días del saldo', fmtDias(r.dias)],
            ['Aging ponderado', `${fmtDec1(r.aging_pond)} d`], ['Estado', r.estado], ['Productos', fmtDias(r.productos)],
          ]} />
        }} />
        <Bar dataKey={metric} radius={[0, 4, 4, 0]} cursor="pointer" animationDuration={600} onClick={(_, i) => rows[i] && onSelect(rows[i].lote)}>
          {rows.map(r => <Cell key={r.lote} fill={metric === 'tn_dias' ? diasColor(r.dias, aging) : APT_COLORS.navy} />)}
          <LabelList dataKey={metric} position="right" fontSize={11} fill="#334155"
            formatter={(v: unknown) => (metric === 'tn_dias' ? fmtAxis(Number(v)) : fmtTn(Number(v)))} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// 4. Productos por TN almacenadas
export function ProductoBars({ data, onSelect }: { data: AptProductoTop[]; onSelect: (producto: string) => void }) {
  const rows = [...data].sort((a, b) => b.tn_saldo - a.tn_saldo).map(r => ({ ...r, label: short(r.glosa || r.producto, 30) }))
  return (
    <ResponsiveContainer width="100%" height={Math.max(220, rows.length * 30 + 20)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 52, left: 0, bottom: 0 }} barCategoryGap={5}>
        <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={fmtAxis} />
        <YAxis type="category" dataKey="label" tick={{ fontSize: 10, fill: '#334155' }} axisLine={false} tickLine={false} width={190} interval={0} />
        <Tooltip cursor={{ fill: '#f1f5f9' }} content={a => {
          const r = tipRow<AptProductoTop>(a)
          return r && <TipBox title={r.producto} subtitle={r.glosa} rows={[
            ['Saldo TN', fmtTn(r.tn_saldo)], ['Días del saldo', fmtDias(r.dias)], ['Aging ponderado', `${fmtDec1(r.aging_pond)} d`],
            ['TN×Días', fmtTn(r.tn_dias)], ['Lotes', fmtDias(r.lotes)],
          ]} />
        }} />
        <Bar dataKey="tn_saldo" radius={[0, 4, 4, 0]} cursor="pointer" animationDuration={600} onClick={(_, i) => rows[i] && onSelect(rows[i].producto)}>
          {rows.map(r => <Cell key={r.producto} fill={APT_COLORS.blue} />)}
          <LabelList dataKey="tn_saldo" position="right" fontSize={11} fill="#334155" formatter={(v: unknown) => fmtTn(Number(v))} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// 5. Entradas vs salidas por periodo
export function FlowChart({ data, grain }: { data: AptTrendPoint[]; grain: AptGrain }) {
  const lines = grain === 'dia'
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
        <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="periodo" tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={v => periodoLabel(String(v), grain)} minTickGap={16} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={fmtAxis} width={44} />
        <Tooltip cursor={{ fill: '#f1f5f9' }} content={a => {
          const r = tipRow<AptTrendPoint>(a)
          return r && <TipBox title={grain === 'dia' ? periodoLabel(r.periodo, 'dia') + '/' + r.periodo.slice(0, 4) : `${periodoLabel(r.periodo, grain)} – ${periodoLabel(r.hasta, 'dia')}`} rows={[
            ['TN entrada', fmtTn(r.tn_in), APT_COLORS.in], ['TN salida', fmtTn(r.tn_out), APT_COLORS.out], ['Neto', fmtTn(r.neto)],
            ['Lotes ingresados', fmtDias(r.lotes_ingresados)], ['Lotes despachados', fmtDias(r.lotes_despachados)],
            ['Días prom. despacho', fmtDec1(r.dias_prom_despacho)],
          ]} />
        }} />
        {lines ? (
          <>
            <Line type="monotone" dataKey="tn_in" name="Entrada" stroke={APT_COLORS.in} strokeWidth={1.8} dot={false} animationDuration={600} />
            <Line type="monotone" dataKey="tn_out" name="Salida" stroke={APT_COLORS.out} strokeWidth={1.8} dot={false} animationDuration={600} />
          </>
        ) : (
          <>
            <Bar dataKey="tn_in" name="Entrada" fill={APT_COLORS.in} radius={[4, 4, 0, 0]} maxBarSize={28} animationDuration={600} />
            <Bar dataKey="tn_out" name="Salida" fill={APT_COLORS.out} radius={[4, 4, 0, 0]} maxBarSize={28} animationDuration={600} />
          </>
        )}
      </ComposedChart>
    </ResponsiveContainer>
  )
}

// 6. Inventario acumulado (saldo) y aging ponderado
export function StockChart({ data, grain }: { data: AptTrendPoint[]; grain: AptGrain }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <ComposedChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="aptStock" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={APT_COLORS.stock} stopOpacity={0.28} />
            <stop offset="100%" stopColor={APT_COLORS.stock} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="periodo" tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={v => periodoLabel(String(v), grain)} minTickGap={16} />
        <YAxis yAxisId="tn" tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={fmtAxis} width={44} />
        <YAxis yAxisId="d" orientation="right" tick={{ ...AXIS_TICK, fill: APT_COLORS.red }} axisLine={false} tickLine={false} width={36}
          tickFormatter={v => `${nf0.format(Number(v))} d`} />
        <Tooltip content={a => {
          const r = tipRow<AptTrendPoint>(a)
          return r && <TipBox title={`Al ${periodoLabel(r.hasta, 'dia')}/${r.hasta.slice(0, 4)}`} rows={[
            ['Saldo en APT', `${fmtTn(r.saldo_tn)} TN`, APT_COLORS.stock], ['Aging ponderado', `${fmtDec1(r.aging_pond)} días`, APT_COLORS.red],
            ['Entradas acumuladas', fmtTn(r.tn_in_acum)], ['Salidas acumuladas', fmtTn(r.tn_out_acum)],
          ]} />
        }} />
        <Area yAxisId="tn" type="monotone" dataKey="saldo_tn" stroke={APT_COLORS.stock} strokeWidth={2} fill="url(#aptStock)" animationDuration={600} />
        <Line yAxisId="d" type="monotone" dataKey="aging_pond" stroke={APT_COLORS.red} strokeWidth={1.8} strokeDasharray="5 3" dot={false} animationDuration={600} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

// 7. Distribución % de TN por rango (donut)
export function AgingDonut({ data, total, onSelect }: { data: AptAgingBucket[]; total: number; onSelect: (rango: string) => void }) {
  const n = data.length
  const rows = data.filter(d => d.tn > 0)
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row lg:flex-col xl:flex-row">
      <div className="relative h-48 w-48 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={rows} dataKey="tn" nameKey="rango" innerRadius="62%" outerRadius="98%" paddingAngle={1.5} stroke="none" cursor="pointer"
              animationDuration={600} onClick={(_, i) => rows[i] && onSelect(rows[i].rango)}>
              {rows.map(d => <Cell key={d.rango} fill={agingColor(data.indexOf(d), n)} />)}
            </Pie>
            <Tooltip content={a => {
              const r = tipRow<AptAgingBucket>(a)
              return r && <TipBox title={r.rango} rows={[['TN', fmtTn(r.tn)], ['% de la TN', fmtPct(r.pct)], ['Lotes', fmtDias(r.lotes)]]} />
            }} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-black tabular-nums text-slate-900">{fmtAxis(total)}</span>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">TN en APT</span>
        </div>
      </div>
      <ul className="w-full space-y-1 text-xs">
        {data.map((d, i) => (
          <li key={d.rango}>
            <button onClick={() => onSelect(d.rango)} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-slate-50">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: agingColor(i, n) }} />
              <span className="flex-1 text-slate-600">{d.rango}</span>
              <span className="tabular-nums text-slate-500">{fmtTn(d.tn)}</span>
              <span className="w-14 text-right font-semibold tabular-nums text-slate-800">{fmtPct(d.pct)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// 10. Estados del inventario: barra 100 % por TN ingresada + leyenda clicable
const ESTADO_ORDEN: AptEstado[] = ['En APT', 'Salida parcial', 'Sin salida identificada', 'Problema de información', 'Despachado']
export function EstadosBar({ data, onSelect, active }: { data: AptEstadoRow[]; onSelect: (e: AptEstado) => void; active?: AptEstado[] }) {
  const rows = ESTADO_ORDEN.map(e => data.find(d => d.estado === e)).filter((d): d is AptEstadoRow => !!d)
  const total = rows.reduce((s, r) => s + r.tn_in, 0)
  return (
    <div className="space-y-3">
      <div className="flex h-5 w-full overflow-hidden rounded-full bg-slate-100">
        {rows.map(r => (
          <button key={r.estado} onClick={() => onSelect(r.estado)} aria-label={`Filtrar ${r.estado}`}
            title={`${r.estado}: ${fmtTn(r.tn_in)} TN ingresadas (${fmtPct(total ? (r.tn_in / total) * 100 : null)})`}
            className="h-full transition-opacity hover:opacity-80"
            style={{ width: `${total ? (r.tn_in / total) * 100 : 0}%`, background: ESTADO_STYLE[r.estado].color, opacity: active?.length && !active.includes(r.estado) ? 0.3 : 1 }} />
        ))}
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider text-slate-400">
            <th className="pb-1 text-left font-semibold">Estado</th>
            <th className="pb-1 text-right font-semibold">TN ingr.</th>
            <th className="pb-1 text-right font-semibold">%</th>
            <th className="pb-1 text-right font-semibold">Saldo TN</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.estado} onClick={() => onSelect(r.estado)} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" title={ESTADO_STYLE[r.estado].help}>
              <td className="py-1.5">
                <span className="flex items-center gap-1.5 text-slate-700">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: ESTADO_STYLE[r.estado].color }} />{r.estado}
                </span>
              </td>
              <td className="py-1.5 text-right tabular-nums text-slate-600">{fmtTn(r.tn_in)}</td>
              <td className="py-1.5 text-right tabular-nums text-slate-500">{fmtPct(total ? (r.tn_in / total) * 100 : null)}</td>
              <td className="py-1.5 text-right font-semibold tabular-nums text-slate-800">{fmtTn(r.tn_saldo)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// 11. Familias por TN (barras pequeñas)
export function FamiliaBars({ data, onSelect }: { data: AptFamiliaTop[]; onSelect: (familia: string) => void }) {
  const max = Math.max(...data.map(d => d.tn_saldo), 0)
  return (
    <ul className="space-y-1.5 text-xs">
      {data.map(d => (
        <li key={d.familia}>
          <button onClick={() => onSelect(d.familia)} className="w-full rounded px-1 py-0.5 text-left hover:bg-slate-50"
            title={`${d.familia}: ${fmtTn(d.tn_saldo)} TN · aging ${fmtDec1(d.aging_pond)} días · ${d.lotes} lotes`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate font-semibold text-slate-700">{d.familia}</span>
              <span className="shrink-0 tabular-nums text-slate-800">
                {fmtTn(d.tn_saldo)} <span className="text-slate-400">· {fmtDias(d.aging_pond)} d</span>
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full rounded-full bg-slate-100">
              <div className="h-1.5 rounded-full bg-[#002855]" style={{ width: `${max > 0 ? Math.max(2, (d.tn_saldo / max) * 100) : 0}%` }} />
            </div>
          </button>
        </li>
      ))}
    </ul>
  )
}
