'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { createClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/caja'

type Finding = { id: string; number: string; severity: string; status: string; has_safety: boolean; excepted: boolean }
type Check = { blocked: boolean; can_grant: boolean; findings: Finding[] }

/** Insignia «Bloqueado por hallazgo» (F3) y, para quien tiene hallazgos-excepcion, el modal de excepción de salida. */
export function AuditFindingReleaseBadge({ dispatchId, status }: { dispatchId: string; status: string }) {
  const db = useMemo(() => createClient(), [])
  const [check, setCheck] = useState<Check | null>(null)
  const [open, setOpen] = useState(false)
  const [finding, setFinding] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = status === 'PROGRAMADO' || status === 'EN_CURSO'

  const load = useCallback(() => Promise.resolve(db.rpc('audit_finding_release_check', { p_dispatch: dispatchId }))
    .then(({ data }) => data?.success ? data as Check : null), [db, dispatchId])
  useEffect(() => {
    let alive = true
    if (pending) void load().then(result => { if (alive) setCheck(result) })
    return () => { alive = false }
  }, [load, pending])

  if (!pending || !check?.blocked) return null
  const blocking = check.findings.filter(f => !f.excepted)
  const exceptable = blocking.filter(f => !f.has_safety)

  const grant = async () => {
    setBusy(true)
    try {
      const { data, error } = await db.rpc('audit_finding_grant_exception', { p_finding: finding, p_dispatch: dispatchId, p_reason: reason })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error || 'No se registró la excepción')
      toast.success('Excepción de salida registrada')
      setOpen(false); setReason(''); setFinding('')
      setCheck(await load())
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }

  return <>
    <span role="status" className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 text-sm font-semibold text-red-800">
      <ShieldAlert aria-hidden className="h-4 w-4" />Bloqueado por hallazgo · {blocking.map(f => f.number).join(', ')}
      {check.can_grant && exceptable.length > 0 && <button type="button" onClick={() => { setFinding(exceptable[0].id); setOpen(true) }}
        className="ml-1 rounded border border-red-300 bg-white px-2 py-1 text-xs font-semibold text-red-800 hover:bg-red-100">Autorizar excepción</button>}
    </span>
    <Modal isOpen={open} onClose={() => setOpen(false)} title="Excepción de salida por hallazgo"
      footer={<div className="flex justify-end gap-2">
        <button type="button" onClick={() => setOpen(false)} className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold">Cancelar</button>
        <button type="button" disabled={busy || reason.trim().length < 20 || !finding} onClick={() => void grant()}
          className="min-h-11 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50">Autorizar salida</button>
      </div>}>
      <div className="space-y-3 text-sm">
        <p className="text-slate-600">La excepción queda registrada en el historial del hallazgo y del despacho. Los hallazgos de seguridad no admiten excepción.</p>
        <label className="block font-medium">Hallazgo
          <select value={finding} onChange={e => setFinding(e.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3">
            {exceptable.map(f => <option key={f.id} value={f.id}>{f.number} · {f.severity === 'CRITICO' ? 'Crítico' : 'Mayor'}</option>)}
          </select>
        </label>
        <label className="block font-medium">Motivo (mínimo 20 caracteres)
          <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} maxLength={1000} className="mt-1 w-full rounded-lg border border-slate-300 p-3" />
        </label>
      </div>
    </Modal>
  </>
}
