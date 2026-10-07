'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'

export function TablePagination({ total, page, pageSize, onPageChange, onPageSizeChange }: {
  total: number; page: number; pageSize: number
  onPageChange: (page: number) => void; onPageSizeChange: (size: number) => void
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const current = Math.min(page, pages)
  return <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white px-3 py-3 text-xs text-slate-500 sm:px-4">
    <p aria-live="polite">{total ? `Mostrando ${(current - 1) * pageSize + 1}–${Math.min(current * pageSize, total)} de ${total} servicios` : '0 servicios'}</p>
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2">Filas<select aria-label="Filas por página" value={pageSize} onChange={e => onPageSizeChange(Number(e.target.value))} className="min-h-11 rounded-lg border border-slate-200 bg-white px-2 text-slate-700">{[25,50,100].map(size => <option key={size} value={size}>{size}</option>)}</select></label>
      <span>Página {current} de {pages}</span>
      <button type="button" aria-label="Página anterior" disabled={current <= 1} onClick={() => onPageChange(current - 1)} className="grid h-11 w-11 place-items-center rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-35"><ChevronLeft className="h-4 w-4" /></button>
      <button type="button" aria-label="Página siguiente" disabled={current >= pages} onClick={() => onPageChange(current + 1)} className="grid h-11 w-11 place-items-center rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-35"><ChevronRight className="h-4 w-4" /></button>
    </div>
  </div>
}
