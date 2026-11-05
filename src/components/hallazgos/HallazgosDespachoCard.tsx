'use client'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ClipboardCheck } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { SEVERITY_LABEL, STATUS_LABEL, type AuditFindingListRow } from '@/lib/audit-findings-pdf'
import { DetailCard } from '@/components/despacho/detalle/DetailParts'
import { HallazgosOtPdfButton } from './HallazgosOtPdfButton'

const SEVERITY_TONE: Record<string, string> = { MENOR: 'bg-slate-100 text-slate-700', MAYOR: 'bg-amber-100 text-amber-900', CRITICO: 'bg-rose-100 text-rose-800' }

/** Hallazgos de auditoría de la OT en el Detalle del despacho; sin permiso o sin hallazgos no se muestra. */
export function HallazgosDespachoCard({ contractId, dispatchId }: { contractId: string; dispatchId: string }) {
  const db = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<(AuditFindingListRow & { dispatch_id?: string | null })[]>([])
  useEffect(() => {
    let live = true
    void db.rpc('audit_finding_list', { p_filters: { contract_id: contractId } }).then(({ data, error }) => {
      if (live && !error && data?.success !== false) setRows(Array.isArray(data) ? data : data?.rows || [])
    })
    return () => { live = false }
  }, [db, contractId])
  if (!rows.length) return null
  const count = (key: 'status' | 'severity', value: string) => rows.filter(r => r[key] === value).length
  return <DetailCard title={`Hallazgos de auditoría (${rows.length})`} icon={<ClipboardCheck />} actions={<HallazgosOtPdfButton contractId={contractId} />}>
    <dl className="grid grid-cols-2 gap-x-4 text-sm">
      {Object.entries(STATUS_LABEL).map(([k, label]) => <div key={k} className="flex justify-between py-1"><dt className="text-slate-700">{label}</dt><dd className="font-semibold tabular-nums">{count('status', k)}</dd></div>)}
      {Object.entries(SEVERITY_LABEL).map(([k, label]) => <div key={k} className="flex justify-between py-1"><dt className="text-slate-700">{label}</dt><dd className="font-semibold tabular-nums">{count('severity', k)}</dd></div>)}
    </dl>
    <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-100 text-sm">
      {rows.map(r => <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
        <Link href={`/despacho/hallazgos?id=${r.id}`} className="font-semibold text-jrm-navy underline-offset-2 hover:underline">{r.number}{r.dispatch_id === dispatchId ? ' · este despacho' : ''}</Link>
        <span className="flex gap-1.5"><span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${SEVERITY_TONE[r.severity] || ''}`}>{SEVERITY_LABEL[r.severity] || r.severity}</span>
          <span className="rounded-md bg-blue-50 px-2 py-0.5 text-xs font-semibold text-jrm-navy">{STATUS_LABEL[r.status] || r.status}</span></span>
      </li>)}
    </ul>
  </DetailCard>
}
