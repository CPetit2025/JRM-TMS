'use client'

import type { ReactNode } from 'react'
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { ArrowRight, Factory, FileCheck2 } from 'lucide-react'
import { APT_COLORS, fmtDec1, fmtPct, fmtTn } from '@/lib/apt/format'
import { ALMACEN_COLOR } from '@/lib/apt/flowColors'
import type { FlowLeadtime } from '@/lib/apt/flowTypes'

// Gráficos de "Tiempos por etapa": línea de etapas producción → 647 → ST → guía, distribuciones, tendencia mensual y ranking.

export const ETAPA_COLOR = { previo: ALMACEN_COLOR['647'], final: ALMACEN_COLOR.ST, linea: APT_COLORS.red }
const AXIS_TICK = { fontSize: 11, fill: '#64748b' }
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
export const mesLabel = (m: string) => { const [y, mm] = m.slice(0, 10).split('-'); return `${MESES[Number(mm) - 1] ?? mm} ${y.slice(2)}` }
const nf0 = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 0 })
const nf1 = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 1 })
export const fmtAxisTn = (v: number) => (Math.abs(v) >= 1000 ? `${nf1.format(v / 1000)} mil` : Math.abs(v) >= 10 ? nf0.format(v) : nf1.format(v))
export const fmtD1 = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${fmtDec1(v)} d`)

export function EtapasTip({ title, subtitle, rows }: { title: ReactNode; subtitle?: ReactNode; rows: Array<[string, ReactNode, string?]> }) {
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
export function tipPayload<T>(a: TipArgs): T | null {
  return a.active && a.payload?.length ? (a.payload[0].payload as T) : null
}

// Línea de etapas proporcional a los días ponderados (con ancho mínimo para que el tramo corto siga siendo legible)
export function EtapasTimeline({ k }: { k: FlowLeadtime['kpis'] }) {
  const previo = Math.max(0, k.dias_previo ?? 0)
  const final = Math.max(0, k.dias_final ?? 0)
  const sum = previo + final
  const MIN = 9
  let wPrev = sum > 0 ? (previo / sum) * 100 : 50
  let wFin = 100 - wPrev
  if (sum > 0 && wFin < MIN) { wFin = MIN; wPrev = 100 - MIN }
  if (sum > 0 && wPrev < MIN) { wPrev = MIN; wFin = 100 - MIN }
  const pctPrev = sum > 0 ? (previo / sum) * 100 : null
  const pctFin = sum > 0 ? (final / sum) * 100 : null
  const scaleMax = Math.max(k.p90 ?? 0, k.dias_total ?? 0, 1) * 1.08
  const pos = (v: number | null) => (v === null ? null : Math.min(100, (v / scaleMax) * 100))
  const marks: Array<{ label: string; v: number | null; cls: string }> = [
    { label: 'P50', v: k.p50, cls: 'bg-slate-500' },
    { label: 'Promedio', v: k.dias_total, cls: 'bg-[#cf152d]' },
    { label: 'P90', v: k.p90, cls: 'bg-slate-800' },
  ]

  return (
    <div className="space-y-5">
      <div className="flex items-stretch gap-2">
        <Node icon={<Factory className="h-4 w-4" />} title="Producción" sub="Ingreso a 647" />
        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <div className="flex h-14 w-full overflow-hidden rounded-lg shadow-inner ring-1 ring-slate-200">
            <Segment w={wPrev} color={ETAPA_COLOR.previo} title="647 · ALM PT" sub="antes del último almacén" dias={previo} pct={pctPrev} />
            <Segment w={wFin} color={ETAPA_COLOR.final} title="ST VENTAS" sub="último almacén" dias={final} pct={pctFin} />
          </div>
          <div className="mt-1 flex justify-between text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            <span>0 d</span>
            <span className="flex items-center gap-1 text-slate-600">Total ponderado <b className="text-[#002855]">{fmtD1(k.dias_total)}</b></span>
          </div>
        </div>
        <Node icon={<FileCheck2 className="h-4 w-4" />} title="Guía" sub="Despacho al cliente" />
      </div>

      <div>
        <p className="mb-1 text-[11px] font-bold uppercase tracking-wider text-slate-500">Dispersión de días producción → guía (por TN)</p>
        <div className="relative h-9">
          <div className="absolute inset-x-0 top-3 h-2 rounded-full bg-gradient-to-r from-emerald-200 via-amber-200 to-red-300" />
          {pos(k.p50) !== null && pos(k.p90) !== null && (
            <div className="absolute top-3 h-2 rounded-full bg-slate-900/15" style={{ left: `${pos(k.p50)}%`, width: `${Math.max(0, (pos(k.p90) ?? 0) - (pos(k.p50) ?? 0))}%` }} />
          )}
          {marks.map(m => {
            const p = pos(m.v)
            if (p === null) return null
            return (
              <div key={m.label} className="absolute top-0 flex -translate-x-1/2 flex-col items-center" style={{ left: `${p}%` }}>
                <span className={`h-8 w-0.5 ${m.cls}`} />
              </div>
            )
          })}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600">
          {marks.map(m => (
            <span key={m.label} className="flex items-center gap-1.5">
              <span className={`inline-block h-3 w-0.5 ${m.cls}`} />{m.label}: <b className="tabular-nums">{fmtD1(m.v)}</b>
            </span>
          ))}
          <span className="text-slate-400">· La mitad de la TN sale en ≤ P50 días; el 90 % en ≤ P90.</span>
        </div>
      </div>
    </div>
  )
}

function Node({ icon, title, sub }: { icon: ReactNode; title: string; sub: string }) {
  return (
    <div className="hidden w-24 shrink-0 flex-col items-center justify-center rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-center sm:flex">
      <span className="text-[#002855]">{icon}</span>
      <span className="mt-1 text-xs font-bold text-slate-800">{title}</span>
      <span className="text-[10px] leading-tight text-slate-500">{sub}</span>
    </div>
  )
}

function Segment({ w, color, title, sub, dias, pct }: { w: number; color: string; title: string; sub: string; dias: number; pct: number | null }) {
  return (
    <div className="group relative flex min-w-0 items-center justify-center px-2 text-white transition-all" style={{ width: `${w}%`, background: color }}
      title={`${title}: ${fmtD1(dias)} (${fmtPct(pct)} del tiempo total)`}>
      <div className="min-w-0 text-center leading-tight">
        <p className="truncate text-xs font-bold">{title} <ArrowRight className="inline h-3 w-3 opacity-70" /></p>
        <p className="truncate text-lg font-black tabular-nums">{fmtD1(dias)}</p>
        <p className="hidden truncate text-[10px] opacity-80 md:block">{sub} · {fmtPct(pct)}</p>
      </div>
    </div>
  )
}

// Distribución de TN por rango de días
const TOTAL_SCALE = ['#10b981', '#a3e635', '#facc15', '#f59e0b', '#ef4444', '#991b1b']
const FINAL_SCALE = [ALMACEN_COLOR.ST, '#5eead4', '#facc15', '#f97316', '#dc2626']
export function EtapasDistribucion({ data, tipo }: { data: FlowLeadtime['distribucion']['total']; tipo: 'total' | 'final' }) {
  const rows = [...data].sort((a, b) => a.orden - b.orden)
  const sum = rows.reduce((s, r) => s + r.tn, 0)
  const scale = tipo === 'total' ? TOTAL_SCALE : FINAL_SCALE
  const items = rows.map((r, i) => ({ ...r, pct: sum > 0 ? (100 * r.tn) / sum : 0, color: scale[Math.min(i, scale.length - 1)] }))
  if (!items.length) return <p className="flex h-56 items-center justify-center text-xs text-slate-400">Sin despachos trazados</p>
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={items} margin={{ top: 24, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="rango" tick={AXIS_TICK} axisLine={false} tickLine={false} interval={0} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={fmtAxisTn} width={44} />
        <Tooltip cursor={{ fill: '#f1f5f9' }} content={a => {
          const r = tipPayload<(typeof items)[number]>(a)
          return r && <EtapasTip title={r.rango} subtitle={tipo === 'total' ? 'Producción → guía' : 'Días en el último almacén antes de la guía'}
            rows={[['TN despachadas', fmtTn(r.tn), r.color], ['% de la TN trazada', fmtPct(r.pct)]]} />
        }} />
        <Bar dataKey="tn" radius={[4, 4, 0, 0]} maxBarSize={56} animationDuration={500}>
          {items.map(it => <Cell key={it.rango} fill={it.color} />)}
          <LabelList dataKey="pct" position="top" formatter={(v: unknown) => fmtPct(Number(v))} style={{ fontSize: 10, fill: '#334155', fontWeight: 600 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// Tendencia mensual: días previo + final apilados y % mismo día
export function EtapasMensual({ data }: { data: FlowLeadtime['mensual'] }) {
  const rows = data.map(m => ({ ...m, label: mesLabel(m.mes), previo: m.dias_previo ?? 0, final: m.dias_final ?? 0 }))
  if (!rows.length) return <p className="flex h-64 items-center justify-center text-xs text-slate-400">Sin datos mensuales</p>
  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={rows} margin={{ top: 20, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} />
        <YAxis yAxisId="d" tick={AXIS_TICK} axisLine={false} tickLine={false} width={36} tickFormatter={v => `${nf0.format(Number(v))} d`} />
        <YAxis yAxisId="p" orientation="right" domain={[0, 100]} tick={AXIS_TICK} axisLine={false} tickLine={false} width={40} tickFormatter={v => `${v} %`} />
        <Tooltip cursor={{ fill: '#f1f5f9' }} content={a => {
          const r = tipPayload<(typeof rows)[number]>(a)
          return r && <EtapasTip title={r.label} subtitle={`${fmtTn(r.tn)} TN trazadas`} rows={[
            ['Días en 647 / previo', fmtD1(r.dias_previo), ETAPA_COLOR.previo],
            ['Días en ST / último', fmtD1(r.dias_final), ETAPA_COLOR.final],
            ['Total producción → guía', fmtD1(r.dias_total)],
            ['% mismo día', fmtPct(r.mismo_dia_pct), ETAPA_COLOR.linea],
          ]} />
        }} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
        <Bar yAxisId="d" dataKey="previo" name="Días antes del último almacén" stackId="d" fill={ETAPA_COLOR.previo} maxBarSize={40} />
        <Bar yAxisId="d" dataKey="final" name="Días en el último almacén" stackId="d" fill={ETAPA_COLOR.final} maxBarSize={40} radius={[4, 4, 0, 0]}>
          <LabelList dataKey="dias_total" position="top" formatter={(v: unknown) => (v === null || v === undefined ? '' : nf1.format(Number(v)))}
            style={{ fontSize: 10, fill: '#334155', fontWeight: 700 }} />
        </Bar>
        <Line yAxisId="p" type="monotone" dataKey="mismo_dia_pct" name="% mismo día" stroke={ETAPA_COLOR.linea} strokeWidth={2}
          dot={{ r: 3, fill: ETAPA_COLOR.linea }} connectNulls />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

// Ranking horizontal de la dimensión elegida: días previo + final apilados
export type EtapasDimRow = FlowLeadtime['por_dim'][number] & { label: string }
export function EtapasDimChart({ rows, onSelect }: { rows: EtapasDimRow[]; onSelect?: (clave: string) => void }) {
  if (!rows.length) return <p className="flex h-40 items-center justify-center text-xs text-slate-400">Sin datos</p>
  const data = rows.map(r => ({ ...r, previo: r.dias_previo ?? 0, final: r.dias_final ?? 0 }))
  const h = Math.max(180, data.length * 26 + 30)
  const click = (d: unknown) => {
    const x = d as { clave?: string; payload?: { clave?: string } }
    const k = x?.payload?.clave ?? x?.clave
    if (k && onSelect) onSelect(k)
  }
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 44, bottom: 0, left: 0 }} barCategoryGap={5}>
        <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={v => `${nf0.format(Number(v))} d`} />
        <YAxis type="category" dataKey="clave" width={150} axisLine={false} tickLine={false} interval={0} tick={{ fontSize: 11, fill: '#475569' }}
          tickFormatter={(k: string) => { const l = data.find(d => d.clave === k)?.label ?? k; return l.length > 24 ? `${l.slice(0, 23)}…` : l }} />
        <Tooltip cursor={{ fill: '#f1f5f9' }} content={a => {
          const r = tipPayload<(typeof data)[number]>(a)
          return r && <EtapasTip title={r.label} rows={[
            ['TN', fmtTn(r.tn)], ['Guías', nf0.format(r.guias)],
            ['Días antes del último almacén', fmtD1(r.dias_previo), ETAPA_COLOR.previo],
            ['Días en el último almacén', fmtD1(r.dias_final), ETAPA_COLOR.final],
            ['Total ponderado', fmtD1(r.dias_total)], ['Máximo', fmtD1(r.max_total)],
          ]} />
        }} />
        <Bar dataKey="previo" stackId="d" fill={ETAPA_COLOR.previo} maxBarSize={16} cursor={onSelect ? 'pointer' : undefined} onClick={click} />
        <Bar dataKey="final" stackId="d" fill={ETAPA_COLOR.final} maxBarSize={16} radius={[0, 4, 4, 0]} cursor={onSelect ? 'pointer' : undefined} onClick={click}>
          <LabelList dataKey="dias_total" position="right" formatter={(v: unknown) => fmtD1(v === null || v === undefined ? null : Number(v))}
            style={{ fontSize: 11, fill: '#334155', fontWeight: 600 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
