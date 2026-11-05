'use client'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ClipboardCheck } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { SEVERITY, STATUS, type FindingRow } from '@/lib/audit-findings'
import { StatusBadge } from '@/components/ui/status-badge'
import { DetailCard } from '@/components/despacho/detalle/DetailParts'
import { HallazgosOtPdfButton } from './HallazgosOtPdfButton'

/** Hallazgos de auditoría de la OT en el Detalle del despacho; sin permiso o sin hallazgos no se muestra. */
export function HallazgosDespachoCard({ contractId, dispatchId }: { contractId: string; dispatchId: string }) {
  const db = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<(FindingRow & { dispatch_id?: string | null })[]>([])
  useEffect(() => {
    let live = true
    void db.rpc('audit_finding_list', { p_filters: { contract_id: contractId } }).then(({ data, error }) => { if (live && !error) setRows(data?.rows || []) })
    return () => { live = false }
  }, [db, contractId])
  if (!rows.length) return null
  const count = (key: 'status' | 'severity', value: string) => rows.filter(r => r[key] === value).length
  return <DetailCard title={`Hallazgos de auditoría (${rows.length})`} icon={<ClipboardCheck />} actions={<HallazgosOtPdfButton contractId={contractId} />}>
    <dl className="grid grid-cols-2 gap-x-4 text-sm">
      {Object.entries(STATUS).map(([k, s]) => <div key={k} className="flex justify-between py-1"><dt className="text-slate-700">{s.label}</dt><dd className="font-semibold tabular-nums">{count('status', k)}</dd></div>)}
      {Object.entries(SEVERITY).map(([k, s]) => <div key={k} className="flex justify-between py-1"><dt className="text-slate-700">{s.label}</dt><dd className="font-semibold tabular-nums">{count('severity', k)}</dd></div>)}
    </dl>
    <ul className="mt-3 divide-y divide-slate-100 border-t border-slate-100 text-sm">
      {rows.map(r => <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
        <Link href={`/despacho/hallazgos?id=${r.id}`} className="font-semibold text-jrm-navy underline-offset-2 hover:underline">{r.number}{r.dispatch_id === dispatchId ? ' · este despacho' : ''}</Link>
        <span className="flex gap-1.5"><StatusBadge tone={SEVERITY[r.severity].tone}>{SEVERITY[r.severity].label}</StatusBadge><StatusBadge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</StatusBadge></span>
      </li>)}
    </ul>
  </DetailCard>
}
