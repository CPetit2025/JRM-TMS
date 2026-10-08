'use client'

import type { ReactNode } from 'react'
import { FilterX } from 'lucide-react'

/** One class for every filter control: same height, border, focus ring across the system. */
export const filterControl = 'h-11 w-full min-w-0 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-jrm-navy'

export function FilterField({ label, className = '', children }: { label: string; className?: string; children: ReactNode }) {
  return <label className={`block min-w-0 text-xs font-medium text-slate-500 ${className}`}>{label}<span className="mt-1 block">{children}</span></label>
}

/** Search + filters in a single compact card. Search first, then dates, type and status; "Limpiar" last. */
export function FilterToolbar({ label, onClear, children }: { label: string; onClear?: () => void; children: ReactNode }) {
  return <section aria-label={label} className="flex flex-wrap items-end gap-3 rounded-jrm border border-jrm-line bg-jrm-surface p-3 shadow-jrm-card sm:p-4">
    {children}
    {onClear && <button type="button" onClick={onClear} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-blue-700 hover:bg-blue-50">
      <FilterX aria-hidden className="h-4 w-4" />Limpiar</button>}
  </section>
}
