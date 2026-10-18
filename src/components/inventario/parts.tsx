'use client'

import type { ReactNode } from 'react'
import { KIND_COLOR, KIND_LABEL, diasClass, fmtDias } from '@/lib/inventario/format'
import type { InvKind } from '@/lib/inventario/types'

// Piezas comunes de la sección Inventario multi-almacén

export function KindBadge({ kind }: { kind: InvKind }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-bold text-slate-600">
      <span className="h-2 w-2 rounded-full" style={{ background: KIND_COLOR[kind] ?? '#94a3b8' }} />{KIND_LABEL[kind] ?? kind}
    </span>
  )
}

export function DiasPill({ dias, title }: { dias: number | null | undefined; title?: string }) {
  return <span title={title} className={`inline-flex min-w-[3rem] justify-center rounded-md border px-1.5 py-0.5 text-xs font-bold tabular-nums ${diasClass(dias)}`}>{fmtDias(dias)}</span>
}

export function PeriodBar({ desde, hasta, onChange, children }: {
  desde: string; hasta: string; onChange: (desde: string, hasta: string) => void; children?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <label className="text-xs font-semibold text-slate-600">Desde
        <input type="date" value={desde} onChange={e => onChange(e.target.value, hasta)} className="mt-1 block min-h-10 rounded-lg border border-slate-300 px-2 text-sm" />
      </label>
      <label className="text-xs font-semibold text-slate-600">Hasta
        <input type="date" value={hasta} onChange={e => onChange(desde, e.target.value)} className="mt-1 block min-h-10 rounded-lg border border-slate-300 px-2 text-sm" />
      </label>
      {children}
    </div>
  )
}

export function Table({ head, children, empty }: { head: ReactNode; children: ReactNode; empty?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-xs">
        <thead className="border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">{head}</thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
      {empty && <p className="py-6 text-center text-sm text-slate-400">Sin registros</p>}
    </div>
  )
}

export const th = 'px-2 py-2 font-bold'
export const td = 'px-2 py-2 align-top'
export const tdNum = 'px-2 py-2 text-right tabular-nums align-top'
