'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'

// Window of page numbers around the current one (1 … 4 5 6 … 20)
function pageWindow(current: number, pages: number): (number | 'gap')[] {
  if (pages <= 5) return Array.from({ length: pages }, (_, i) => i + 1)
  const set = new Set([1, pages, current - 1, current, current + 1].filter(n => n >= 1 && n <= pages))
  const sorted = [...set].sort((a, b) => a - b)
  return sorted.flatMap((n, i) => i > 0 && n - sorted[i - 1] > 1 ? ['gap' as const, n] : [n])
}

export function TablePagination({ total, page, pageSize, onPageChange, onPageSizeChange, itemLabel = 'servicios', pageSizeOptions = [25, 50, 100] }: {
  total: number; page: number; pageSize: number
  onPageChange: (page: number) => void; onPageSizeChange: (size: number) => void
  itemLabel?: string; pageSizeOptions?: number[]
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const current = Math.min(page, pages)
  const arrow = 'grid h-11 w-11 place-items-center rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-35'
  return <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white px-3 py-3 text-xs text-slate-500 sm:px-4">
    <p aria-live="polite">{total ? `Mostrando ${(current - 1) * pageSize + 1} a ${Math.min(current * pageSize, total)} de ${total} ${itemLabel}` : `0 ${itemLabel}`}</p>
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2">Registros por página<select aria-label="Filas por página" value={pageSize} onChange={e => onPageSizeChange(Number(e.target.value))} className="min-h-11 rounded-lg border border-slate-200 bg-white px-2 text-slate-700">{pageSizeOptions.map(size => <option key={size} value={size}>{size}</option>)}</select></label>
      <button type="button" aria-label="Página anterior" disabled={current <= 1} onClick={() => onPageChange(current - 1)} className={arrow}><ChevronLeft className="h-4 w-4" /></button>
      <span className="sr-only">Página {current} de {pages}</span>
      <ol className="hidden items-center gap-1 sm:flex">{pageWindow(current, pages).map((n, i) => n === 'gap'
        ? <li key={`gap-${i}`} aria-hidden className="px-1 text-slate-400">…</li>
        : <li key={n}><button type="button" aria-label={`Página ${n}`} aria-current={n === current ? 'page' : undefined} onClick={() => onPageChange(n)}
            className={`grid h-11 min-w-11 place-items-center rounded-lg border px-2 text-sm font-semibold tabular-nums ${n === current ? 'border-jrm-navy bg-jrm-navy text-white' : 'border-slate-200 text-slate-700 hover:bg-slate-50'}`}>{n}</button></li>)}</ol>
      <span aria-hidden className="sm:hidden">{current} / {pages}</span>
      <button type="button" aria-label="Página siguiente" disabled={current >= pages} onClick={() => onPageChange(current + 1)} className={arrow}><ChevronRight className="h-4 w-4" /></button>
    </div>
  </div>
}
