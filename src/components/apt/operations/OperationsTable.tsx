'use client'

import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { DataTable } from '@/components/ui/data-table'
import { fmtDateTime, fmtDec1, fmtTn } from '@/lib/apt/format'
import { operationalDecision, operationalReadinessState, operationalOt, operationalTraceHref, type OperationalReadiness, type OperationalSourceRow } from '@/lib/apt/operations'

export function OperationsTable({ rows, fresh, cutoff, alertDays, readiness = [], canEdit = false, onEdit, rebuiltAt = null }: { rows: OperationalSourceRow[]; fresh: boolean; cutoff: string | null; alertDays: number | null; readiness?: OperationalReadiness[]; canEdit?: boolean; onEdit?: (row: OperationalSourceRow) => void; rebuiltAt?: string | null }) {
  return <div className="overflow-x-auto"><DataTable dense className="min-w-[1100px] w-full text-xs">
    <caption className="sr-only">Control del saldo por lote y almacén. Las acciones son de revisión; no acreditan autorización para despachar.</caption>
    <thead><tr>{['OT / lote', 'Cliente', 'Ubicación', 'Saldo TN', 'Antigüedad', 'Disponibilidad', 'Revisión necesaria', 'Causa / responsable', 'Próxima acción', 'Detalle'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
    <tbody>{rows.map(row => {
      const decision = operationalDecision(row, fresh, alertDays)
      const registered = readiness.find(item => item.almacen === row.almacen && item.lote === row.lote && item.producto === '*')
      const availability = operationalReadinessState(registered, rebuiltAt)
      const ot = operationalOt(row.lote)
      const style = decision.tone === 'red' ? 'bg-red-50 text-red-700' : decision.tone === 'amber' ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-700'
      return <tr key={`${row.almacen}|${row.lote}`}>
        <td><span className="font-bold text-[#002855]">{ot ? `OT ${ot}` : 'OT no identificada'}</span><p className="mt-1 text-[11px] text-slate-500">{row.lote}</p></td>
        <td className="max-w-48"><span className="block truncate" title={row.cliente || ''}>{row.cliente || 'Sin cliente identificado'}</span></td>
        <td className="font-semibold">{row.almacen === 'ST' ? 'ST VENTAS' : row.almacen}</td>
        <td className="text-right font-bold tabular-nums">{fmtTn(row.stock_tn)}</td>
        <td className="tabular-nums whitespace-nowrap">{row.age_days === null ? 'No evaluable' : `${fmtDec1(row.age_days)} d`}<p className="text-[10px] text-slate-500">Ponderada por TN</p></td>
        <td><span className={availability.status === 'BLOQUEADO' ? 'font-bold text-red-700' : 'text-slate-600'}>{availability.status === 'DISPONIBLE' ? 'Disponible según revisión' : availability.status === 'BLOQUEADO' ? 'Bloqueado' : 'No evaluada'}</span>{registered && <p className="mt-1 text-[10px] text-slate-500">Evaluación manual · {fmtDateTime(registered.updated_at)}</p>}{availability.needsReview && <p className="mt-1 text-[10px] font-semibold text-amber-700">Revisión anterior al recálculo. Requiere confirmar nuevamente.</p>}</td>
        <td><span className={`inline-flex rounded-full px-2 py-1 text-[10px] font-bold whitespace-nowrap ${style}`}>{decision.label}</span><p className="mt-1 max-w-52 text-[11px] text-slate-500">{decision.reason}</p></td>
        <td><p>{registered?.reason || 'Sin causa registrada'}</p><p className="mt-1 text-[11px] text-slate-500">{registered?.responsible_name || 'Responsable sin asignar'}</p></td>
        <td className="max-w-56 text-slate-600">{availability.needsReview ? 'Actualizar la revisión operativa con el saldo recalculado.' : registered?.next_action || decision.nextAction}</td>
        <td><Link href={operationalTraceHref(row.lote, cutoff)} className="inline-flex min-h-10 items-center gap-1 rounded-lg border border-slate-200 px-3 font-semibold text-[#002855] hover:bg-slate-50" aria-label={`Ver trazabilidad de ${row.lote}`}><ArrowUpRight className="h-4 w-4" />Trazabilidad</Link>{canEdit && row.stock_tn > 0 && onEdit && <button onClick={() => onEdit(row)} className="mt-2 block min-h-10 rounded-lg bg-[#002855] px-3 font-semibold text-white">Registrar revisión</button>}</td>
      </tr>
    })}{!rows.length && <tr><td colSpan={10} className="py-12 text-center text-slate-500">No hay saldo con estos filtros.</td></tr>}</tbody>
  </DataTable></div>
}
