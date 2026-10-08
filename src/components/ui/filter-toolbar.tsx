'use client'

import type { ReactNode } from 'react'
import { FilterX } from 'lucide-react'

/** One class for every filter control: same height, border, focus ring across the system. */
export const filterControl = 'h-10 w-full min-w-0 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-jrm-navy'

export function FilterField({ label, className = '', inline = false, children }: { label: string; className?: string; inline?: boolean; children: ReactNode }) {
  return inline
    ? <label className={`flex min-w-0 items-center gap-2 text-sm text-slate-500 ${className}`}><span className="shrink-0">{label}</span><span className="block min-w-0 flex-1">{children}</span></label>
    : <label className={`block min-w-0 text-xs font-medium text-slate-500 ${className}`}>{label}<span className="mt-1 block">{children}</span></label>
}

/** Search + filters in a single compact card. Search first, then dates, type and status; "Limpiar" last. */
export function FilterToolbar({ label, onClear, compact = false, children }: { label: string; onClear?: () => void; compact?: boolean; children: ReactNode }) {
  return <section aria-label={label} className={`flex flex-wrap rounded-jrm border border-jrm-line bg-jrm-surface shadow-jrm-card ${compact ? 'items-center gap-x-4 gap-y-2 p-2' : 'items-end gap-3 p-3 sm:p-4'}`}>
    {children}
    {onClear && <button type="button" onClick={onClear} className={`inline-flex items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-blue-700 hover:bg-blue-50 ${compact ? 'h-10 border border-slate-200 bg-white' : 'min-h-11'}`}>
      <FilterX aria-hidden className="h-4 w-4" />Limpiar</button>}
  </section>
}
