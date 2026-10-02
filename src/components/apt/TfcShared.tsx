'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, X } from 'lucide-react'

// Piezas compartidas por Tendencias, FechaEntrega y Calidad de datos

// Carga asíncrona sin setState síncrono en el efecto: el resultado se asocia a la función y al número de reintento
export function useAptQuery<T>(fetcher: () => Promise<T>) {
  const [nonce, setNonce] = useState(0)
  const [res, setRes] = useState<{ src: () => Promise<T>; nonce: number; data?: T; error?: string } | null>(null)
  useEffect(() => {
    let alive = true
    fetcher().then(
      data => { if (alive) setRes({ src: fetcher, nonce, data }) },
      (e: unknown) => { if (alive) setRes({ src: fetcher, nonce, error: e instanceof Error ? e.message : 'No se pudo cargar la información' }) },
    )
    return () => { alive = false }
  }, [fetcher, nonce])
  const current = res?.src === fetcher && res.nonce === nonce
  const retry = useCallback(() => setNonce(n => n + 1), [])
  // Mientras recarga se conservan los datos anteriores (evita parpadeos al cambiar filtros o grano)
  return { data: res?.data, error: current ? res?.error : undefined, loading: !current, retry }
}

// Tooltip de recharts: tarjeta blanca con valores ya formateados
export interface TipEntry { name?: string | number; value?: unknown; color?: string; dataKey?: unknown; payload?: Record<string, unknown> }
export function ChartTip({ active, payload, label, labelFmt, fmt, extra }: {
  active?: boolean; payload?: ReadonlyArray<TipEntry>; label?: unknown
  labelFmt?: (label: unknown, row?: Record<string, unknown>) => ReactNode
  fmt?: (value: unknown, dataKey: string) => string
  extra?: (row: Record<string, unknown>) => ReactNode
}) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload
  return (
    <div className="min-w-[180px] rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg">
      <p className="mb-1.5 font-bold text-slate-800">{labelFmt ? labelFmt(label, row) : String(label ?? '')}</p>
      <div className="space-y-1">
        {payload.map((p, i) => (
          <div key={i} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-slate-600">
              <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />{p.name}
            </span>
            <span className="font-semibold tabular-nums text-slate-900">{fmt ? fmt(p.value, String(p.dataKey ?? '')) : String(p.value ?? '—')}</span>
          </div>
        ))}
      </div>
      {extra && row ? <div className="mt-1.5 border-t border-slate-100 pt-1.5 text-slate-500">{extra(row)}</div> : null}
    </div>
  )
}

export const AXIS_TICK = { fontSize: 11, fill: '#64748b' }

// Botones segmentados
export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5">
      {options.map(o => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)} aria-pressed={value === o.value}
          className={`rounded-md px-3 py-1 text-xs font-bold transition-colors ${
            value === o.value ? 'bg-white text-[#002855] shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

// Orden de tablas
export type SortState = { key: string; desc: boolean }
export function sortRows<T>(rows: T[], s: SortState): T[] {
  const get = (r: T) => (r as Record<string, unknown>)[s.key]
  return [...rows].sort((a, b) => {
    const va = get(a), vb = get(b)
    if (va === vb) return 0
    if (va === null || va === undefined) return 1
    if (vb === null || vb === undefined) return -1
    const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'es', { numeric: true })
    return s.desc ? -c : c
  })
}
export function SortTh({ k, sort, onSort, children, right = true, title }: {
  k: string; sort: SortState; onSort: (s: SortState) => void; children: ReactNode; right?: boolean; title?: string
}) {
  const active = sort.key === k
  const Icon = !active ? ArrowUpDown : sort.desc ? ArrowDown : ArrowUp
  return (
    <th title={title} aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}
      className={`whitespace-nowrap px-3 py-2 font-bold ${right ? 'text-right' : 'text-left'}`}>
      <button type="button" onClick={() => onSort({ key: k, desc: active ? !sort.desc : true })}
        className={`inline-flex items-center gap-1 hover:text-[#002855] ${active ? 'text-[#002855]' : ''}`}>
        {children}<Icon className="h-3 w-3 opacity-60" />
      </button>
    </th>
  )
}

export function ExportButton({ onClick, label = 'Exportar Excel', disabled }: { onClick: () => void; label?: string; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 shadow-sm hover:border-[#002855] hover:text-[#002855] disabled:opacity-50">
      {label}
    </button>
  )
}

export function Modal({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose} role="dialog" aria-modal="true">
      <div className="max-h-[85vh] w-full max-w-2xl overflow-hidden rounded-xl bg-white shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h3 className="text-sm font-bold text-slate-800">{title}</h3>
          <button type="button" onClick={onClose} aria-label="Cerrar" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[calc(85vh-52px)] overflow-auto p-4">{children}</div>
      </div>
    </div>
  )
}

// Suma de días a una fecha ISO (aaaa-mm-dd) sin problemas de zona horaria
export function addDays(iso: string, n: number) {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
export function diffDays(a: string, b: string) {
  return Math.round((Date.parse(`${a.slice(0, 10)}T00:00:00Z`) - Date.parse(`${b.slice(0, 10)}T00:00:00Z`)) / 86400000)
}
