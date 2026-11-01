'use client'
import { useCallback, useEffect, useState } from 'react'
import { Loader2, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/modal'
import { errorMessage, money } from '@/lib/caja'

// Autorizaciones para comprometer por encima del tope de la partida (etapa 3 del control presupuestal):
// Supervisor/Programación solicita → Jefe de Distribución recomienda → Gerencia de Operaciones autoriza o rechaza.
// Una emergencia queda autorizada de inmediato y Gerencia la ratifica. Nunca cambia la partida (R4).

type Authorization = {
  id: string; contract_id: string; code: string; amount_pen: number; reason: string; evidence: string | null; emergency: boolean
  status: 'SOLICITADA' | 'RECOMENDADA' | 'AUTORIZADA' | 'RECHAZADA' | 'ANULADA'; requested_at: string; requested_by: string | null
  recommended_by: string | null; recommendation: string | null; decided_by: string | null; decided_at: string | null; decision_note: string | null
  regularize_by: string | null; valid_until: string; pending_ratification: boolean
}
type List = { can_request: boolean; can_recommend: boolean; can_authorize: boolean; rows: Authorization[] }
export type AuthorizationTarget = { contract_id: string; code: string; needs_pen?: number }

const supabase = createClient()
const STATUS: Record<Authorization['status'], string> = {
  SOLICITADA: 'bg-amber-100 text-amber-800', RECOMENDADA: 'bg-blue-100 text-blue-800', AUTORIZADA: 'bg-emerald-100 text-emerald-800',
  RECHAZADA: 'bg-red-100 text-red-700', ANULADA: 'bg-slate-100 text-slate-600',
}
const input = 'w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-[#002855]'
const fmt = (v: string | null) => (v ? new Date(v).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' }) : '')

export function BudgetAuthorizations({ target, onTargetDone, onChanged }: { target: AuthorizationTarget | null; onTargetDone: () => void; onChanged: () => void }) {
  const [list, setList] = useState<List | null>(null)
  const [form, setForm] = useState({ amount: '', reason: '', evidence: '', emergency: false })
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('budget_authorizations_list')
    if (error || !data?.success) { toast.error(error ? errorMessage(error) : data?.error); return }
    setList(data as List)
  }, [])
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [load])
  useEffect(() => { const t = window.setTimeout(() => setForm({ amount: target?.needs_pen ? Number(target.needs_pen).toFixed(2) : '', reason: '', evidence: '', emergency: false }), 0); return () => window.clearTimeout(t) }, [target])

  const done = (msg: string) => { toast.success(msg); void load(); onChanged() }
  const request = async () => {
    if (!target) return
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('budget_authorization_request', { p_contract: target.contract_id, p_amount: Number(form.amount),
        p_reason: form.reason.trim(), p_evidence: form.evidence.trim() || null, p_emergency: form.emergency })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error)
      done(form.emergency ? 'Emergencia autorizada de forma provisional: Gerencia debe ratificarla' : 'Solicitud enviada'); onTargetDone()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  const act = async (a: Authorization, action: string, ask?: string) => {
    let note: string | null = null
    if (ask) { note = window.prompt(ask); if (note === null) return }
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('budget_authorization_action', { p_id: a.id, p_action: action, p_note: note })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error)
      done(`OT ${a.code}: ${data.status.toLowerCase()}`)
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }

  const open = (list?.rows || []).filter(a => ['SOLICITADA', 'RECOMENDADA'].includes(a.status) || a.pending_ratification)
  const history = (list?.rows || []).filter(a => !open.includes(a)).slice(0, 15)
  const btn = 'rounded border px-2 py-0.5 text-xs font-semibold disabled:opacity-50'
  const row = (a: Authorization) => <li key={a.id} className="rounded-lg border border-slate-200 p-2 text-sm">
    <div className="flex flex-wrap items-center gap-2"><b className="text-[#002855]">OT {a.code}</b><span className="tabular-nums">S/ {money(Number(a.amount_pen))} sobre el tope</span>
      <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${STATUS[a.status]}`}>{a.pending_ratification ? 'Emergencia por ratificar' : a.status.toLowerCase()}</span>
      <span className="text-xs text-slate-500">{a.requested_by} · {fmt(a.requested_at)}{a.status === 'AUTORIZADA' ? ` · vigente hasta ${a.valid_until}` : ''}</span></div>
    <p className="text-xs text-slate-700">{a.reason}{a.evidence ? ` · Evidencia: ${a.evidence}` : ''}</p>
    {(a.recommendation || a.decision_note) && <p className="text-xs text-slate-500">{a.recommended_by ? `Jefe: ${a.recommendation || 'recomendó'}` : ''}{a.decided_by ? ` · Gerencia (${a.decided_by}): ${a.decision_note || a.status.toLowerCase()}` : ''}</p>}
    <div className="mt-1 flex flex-wrap gap-1">
      {list?.can_recommend && a.status === 'SOLICITADA' && <>
        <button type="button" disabled={busy} onClick={() => void act(a, 'RECOMENDAR', 'Comentario para Gerencia (opcional)')} className={`${btn} border-blue-300 text-blue-800`}>Recomendar</button>
        <button type="button" disabled={busy} onClick={() => void act(a, 'NO_RECOMENDAR', 'Por qué no se recomienda')} className={`${btn} border-red-300 text-red-700`}>No recomendar</button></>}
      {list?.can_authorize && ['SOLICITADA', 'RECOMENDADA'].includes(a.status) && <>
        <button type="button" disabled={busy} onClick={() => void act(a, 'AUTORIZAR', 'Nota de la autorización (opcional)')} className={`${btn} border-emerald-400 bg-emerald-600 text-white`}>Autorizar</button>
        <button type="button" disabled={busy} onClick={() => void act(a, 'RECHAZAR', 'Motivo del rechazo')} className={`${btn} border-red-300 text-red-700`}>Rechazar</button></>}
      {list?.can_authorize && a.pending_ratification && <>
        <button type="button" disabled={busy} onClick={() => void act(a, 'RATIFICAR')} className={`${btn} border-emerald-400 bg-emerald-600 text-white`}>Ratificar emergencia</button>
        <button type="button" disabled={busy} onClick={() => void act(a, 'RECHAZAR', 'Motivo del rechazo')} className={`${btn} border-red-300 text-red-700`}>Rechazar</button></>}
      {list?.can_authorize && a.status === 'AUTORIZADA' && !a.pending_ratification && <button type="button" disabled={busy} onClick={() => void act(a, 'ANULAR', 'Motivo de la anulación')} className={`${btn} border-slate-300 text-slate-700`}>Anular</button>}
    </div>
  </li>

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-3">
      <h2 className="flex items-center gap-2 font-bold text-slate-800"><ShieldAlert className="h-4 w-4" />Autorizaciones sobre el tope</h2>
      <p className="text-[11px] text-slate-500">Permiten comprometer por encima del tope sin cambiar la partida ni ocultar el sobrecosto. Nunca más allá del 100 % (eso es una ampliación presupuestal).</p>
      {!list ? <Loader2 className="mt-2 h-4 w-4 animate-spin text-slate-400" /> : <>
        {open.length ? <ul className="mt-2 space-y-2">{open.map(row)}</ul> : <p className="mt-2 text-sm text-slate-500">No hay solicitudes pendientes.</p>}
        {history.length > 0 && <details className="mt-2"><summary className="cursor-pointer text-xs font-semibold text-slate-600">Historial reciente ({history.length})</summary><ul className="mt-2 space-y-2">{history.map(row)}</ul></details>}
      </>}
      <Modal isOpen={!!target} onClose={onTargetDone} title={target ? `Solicitar autorización · OT ${target.code}` : ''} maxWidth="max-w-md">
        <div className="space-y-3 text-sm">
          <label className="block"><span className="mb-0.5 block text-xs font-semibold text-slate-600">Monto sobre el tope (S/)</span>
            <input inputMode="decimal" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} className={input} /></label>
          <label className="block"><span className="mb-0.5 block text-xs font-semibold text-slate-600">Motivo *</span>
            <textarea rows={3} value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder="Por qué se necesita comprometer por encima del tope" className={input} /></label>
          <label className="block"><span className="mb-0.5 block text-xs font-semibold text-slate-600">Evidencia</span>
            <input value={form.evidence} onChange={e => setForm({ ...form, evidence: e.target.value })} placeholder="Correo, orden del cliente, enlace…" className={input} /></label>
          <label className="flex items-start gap-2"><input type="checkbox" checked={form.emergency} onChange={e => setForm({ ...form, emergency: e.target.checked })} className="mt-1" />
            <span>Emergencia operativa: queda autorizada de inmediato y Gerencia debe ratificarla.</span></label>
          <button type="button" disabled={busy || !(Number(form.amount) > 0) || form.reason.trim().length < 10} onClick={() => void request()}
            className="min-h-10 w-full rounded-lg bg-[#002855] px-4 font-semibold text-white disabled:opacity-50">{busy ? 'Enviando…' : 'Enviar solicitud'}</button>
        </div>
      </Modal>
    </section>
  )
}
