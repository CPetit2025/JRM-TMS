'use client'
import { useMemo, useState } from 'react'
import { FileDown, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { downloadAuditFindingsPdf } from '@/lib/audit-findings-pdf'

/** «PDF de la OT»: reporte de todos los hallazgos de la OT (contrato), generado en el navegador. */
export function HallazgosOtPdfButton({ contractId, className = '' }: { contractId: string; className?: string }) {
  const db = useMemo(() => createClient(), [])
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try { await downloadAuditFindingsPdf(db, contractId) } catch (e) { toast.error(e instanceof Error ? e.message : 'No se pudo generar el PDF') } finally { setBusy(false) }
  }
  return <button type="button" onClick={() => void run()} disabled={busy}
    className={`inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-jrm-navy hover:bg-slate-50 disabled:opacity-50 ${className}`}>
    {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <FileDown className="h-4 w-4" aria-hidden />}PDF de la OT</button>
}
