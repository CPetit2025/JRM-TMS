'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, FileSpreadsheet, Loader2 } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { APT_COLORS } from '@/lib/apt/format'

// Piezas compartidas por las pantallas Productos y glosas, Pareto y Mapa de calor

// Carga asíncrona por clave: conserva los datos anteriores mientras recalcula y evita setState síncrono en efectos
export function useAsyncData<T>(key: string, fetcher: () => Promise<T>) {
  const [nonce, setNonce] = useState(0)
  const fullKey = `${key}#${nonce}`
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>({ key: '' })
  useEffect(() => {
    let alive = true
    fetcher()
      .then(data => { if (alive) setState({ key: fullKey, data }) })
      .catch((e: unknown) => { if (alive) setState(s => ({ key: fullKey, data: s.data, error: e instanceof Error ? e.message : String(e) })) })
    return () => { alive = false }
    // fetcher cambia en cada render; la clave resume sus dependencias
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullKey])
  const current = state.key === fullKey
  return {
    data: state.data,
    error: current ? state.error : undefined,
    loading: !current,
    reload: () => setNonce(n => n + 1),
  }
}

export function Segmented<T extends string | number>({ value, options, onChange, label }: {
  value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label?: string
}) {
  return (
    <div className="flex items-center gap-2">
      {label && <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{label}</span>}
      <div role="tablist" className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
        {options.map(o => (
          <button key={String(o.value)} role="tab" aria-selected={o.value === value} type="button" onClick={() => onChange(o.value)}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-all ${
              o.value === value ? 'bg-white text-[#002855] shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-800'}`}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function SortTh({ label, k, sort, desc, onSort, align = 'right', title, className = '' }: {
  label: ReactNode; k: string; sort: string; desc: boolean; onSort: (k: string) => void; align?: 'left' | 'right' | 'center'; title?: string; className?: string
}) {
  const active = sort === k
  const Icon = active ? (desc ? ArrowDown : ArrowUp) : ArrowUpDown
  return (
    <th title={title} aria-sort={active ? (desc ? 'descending' : 'ascending') : 'none'}
      className={`sticky top-0 z-10 whitespace-nowrap border-b border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-slate-500 ${{ left: 'text-left', right: 'text-right', center: 'text-center' }[align]} ${className}`}>
      <button type="button" onClick={() => onSort(k)}
        className={`inline-flex items-center gap-1 hover:text-slate-800 ${active ? 'text-[#002855]' : ''} ${align === 'right' ? 'flex-row-reverse' : ''}`}>
        {label}<Icon className={`h-3 w-3 ${active ? '' : 'opacity-40'}`} />
      </button>
    </th>
  )
}

export function ExportButton({ onClick, busy, disabled }: { onClick: () => void; busy?: boolean; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={busy || disabled}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-100 disabled:opacity-50">
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />} Exportar Excel
    </button>
  )
}

export function TooltipBox({ title, subtitle, rows }: { title: ReactNode; subtitle?: ReactNode; rows: Array<[string, ReactNode]> }) {
  return (
    <div className="max-w-xs rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg">
      <p className="font-bold text-slate-800">{title}</p>
      {subtitle && <p className="mb-1 line-clamp-2 text-[11px] text-slate-500">{subtitle}</p>}
      <div className="mt-1 space-y-0.5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4">
            <span className="text-slate-500">{k}</span><span className="font-semibold tabular-nums text-slate-800">{v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export const truncate = (s: string | null | undefined, n: number) => (!s ? '' : s.length > n ? `${s.slice(0, n - 1)}…` : s)

export interface RankItem { key: string; label: string; sub?: string | null; value: number; color?: string; extra?: Array<[string, ReactNode]> }

// Ranking horizontal (top N) con etiquetas de valor y clic para filtrar
export function RankBars({ items, format, color = APT_COLORS.navy, onSelect, height, labelWidth = 150 }: {
  items: RankItem[]; format: (v: number) => string; color?: string; onSelect?: (key: string) => void; height?: number; labelWidth?: number
}) {
  if (!items.length) return <p className="flex h-40 items-center justify-center text-xs text-slate-400">Sin datos con saldo</p>
  const h = height ?? Math.max(160, items.length * 28 + 16)
  const chars = Math.floor(labelWidth / 6.2)
  return (
    <ResponsiveContainer width="100%" height={h}>
      <BarChart data={items} layout="vertical" margin={{ top: 0, right: 56, bottom: 0, left: 0 }} barCategoryGap={5}>
        <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" hide domain={[0, 'dataMax']} />
        <YAxis type="category" dataKey="key" width={labelWidth} axisLine={false} tickLine={false} interval={0}
          tick={{ fontSize: 11, fill: '#475569' }} tickFormatter={(k: string) => truncate(items.find(i => i.key === k)?.label ?? k, chars)} />
        <Tooltip cursor={{ fill: '#f1f5f9' }} content={({ active, payload }) => {
          const it = active && payload?.[0]?.payload as RankItem | undefined
          if (!it) return null
          return <TooltipBox title={it.label} subtitle={it.sub} rows={[['Valor', format(it.value)], ...(it.extra || [])]} />
        }} />
        <Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={18} animationDuration={500}
          cursor={onSelect ? 'pointer' : undefined} onClick={(d) => {
            const x = d as unknown as { key?: string; payload?: RankItem }
            const k = x?.payload?.key ?? x?.key
            if (k && onSelect) onSelect(k)
          }}>
          {items.map(it => <Cell key={it.key} fill={it.color || color} />)}
          <LabelList dataKey="value" position="right" formatter={(v: unknown) => format(Number(v))} style={{ fontSize: 11, fill: '#334155', fontWeight: 600 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
