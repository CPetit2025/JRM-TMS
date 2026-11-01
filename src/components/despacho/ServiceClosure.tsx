"use client"
import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, CircleDashed, Lock } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { errorMessage, money } from '@/lib/caja'
import { EconomicClosurePanel } from '@/components/despacho/EconomicClosurePanel'
import { DispatchDocumentarySettlement } from '@/components/documentos/DispatchDocumentarySettlement'
import { Modal } from '@/components/ui/modal'
import { TripExpenses } from '@/components/caja/ExpenseReview'

// Cierre del servicio en Torre de Control: los cuatro procesos del viaje con su estado (dispatch_closure_status) y el
// cierre final (dispatch_final_close). Cada estado es independiente: la documentación puede estar completa con lo
// económico pendiente. El cierre final no cierra la OT (docs/control-presupuestal/reingenieria-torre-control.md).

export type ClosureChecks = {
  operativo: { ok: boolean; status: string }
  documentario: { ok: boolean; status: string; pending: number }
  economico: { ok: boolean; status: string }
  caja: { ok: boolean; pending: number; pending_pen: number }
  ready: boolean
  final: { closed_at: string; closed_by: string | null; exception: boolean; note: string | null } | null
}
type Status = { success: boolean; error?: string; can_close: boolean; can_except: boolean; rows: Record<string, ClosureChecks> }

const supabase = createClient()
const ECON: Record<string, string> = { PENDIENTE: 'Pendiente', EN_REVISION: 'En revisión', OBSERVADO: 'Observado', CIERRE_PARCIAL: 'Cierre parcial', CERRADO: 'Cerrado', NO_APLICA: 'No aplica' }
const DOC: Record<string, string> = { PENDIENTE: 'Pendiente', OBSERVADO: 'Observada', COMPLETO: 'Completa' }

/** Estado resumido para la lista de Torre de Control */
export const closureStage = (c: ClosureChecks | undefined) => !c ? null : c.final ? 'CERRADO' : !c.operativo.ok ? null
  : c.ready ? 'LISTO' : !c.documentario.ok ? 'DOCUMENTARIO' : !c.economico.ok ? 'ECONOMICO' : 'CAJA'

export function ServiceClosure({ dispatchId, openEconomic = false, openDocumentary = false, onChanged }: { dispatchId: string; openEconomic?: boolean; openDocumentary?: boolean; onChanged?: () => void }) {
  const [state, setState] = useState<Status | null>(null)
  const [econ, setEcon] = useState(openEconomic)
  const [docs, setDocs] = useState(openDocumentary)
  const [caja, setCaja] = useState(false)
  const [note, setNote] = useState('')
  const [mode, setMode] = useState<'exception' | 'reopen' | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('dispatch_closure_status', { p_dispatch_ids: [dispatchId] })
    if (error || !data?.success) { toast.error(error ? errorMessage(error) : data?.error); return }
    setState(data as Status)
  }, [dispatchId])
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [load])

  const act = async (rpc: string, args: Record<string, unknown>, ok: string) => {
    setBusy(true)
    const { data, error } = await supabase.rpc(rpc, args)
    setBusy(false)
    if (error || !data?.success) { toast.error(error ? errorMessage(error) : data?.error); return }
    toast.success(ok); setMode(null); setNote(''); void load(); onChanged?.()
  }

  const c = state?.rows?.[dispatchId]
  if (!state || !c) return null
  const item = (ok: boolean, title: string, detail: string, action?: React.ReactNode) => (
    <div className={`rounded-lg border p-3 ${ok ? 'border-emerald-200 bg-emerald-50/50' : 'border-amber-200 bg-amber-50/50'}`}>
      <p className="flex items-center gap-1.5 text-sm font-semibold">{ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <CircleDashed className="h-4 w-4 text-amber-600" />}{title}</p>
      <p className="mt-1 text-xs text-slate-600">{detail}</p>
      {action && <div className="mt-2 text-xs">{action}</div>}
    </div>
  )

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4" aria-label="Cierre del servicio">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-bold text-slate-800">Cierre del servicio</h3>
        {c.final ? <span className="flex items-center gap-1 rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800"><Lock className="h-3.5 w-3.5" />
          Cerrado{c.final.exception ? ' con excepción' : ''} · {new Date(c.final.closed_at).toLocaleDateString('es-PE', { timeZone: 'America/Lima' })}{c.final.closed_by ? ` · ${c.final.closed_by}` : ''}</span>
          : <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">{c.ready ? 'Listo para el cierre final' : 'Cierre final pendiente'}</span>}
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {item(c.operativo.ok, 'Ruta y seguimiento', c.operativo.ok ? 'Ruta cerrada y partida ejecutada' : 'Falta cerrar la ruta (Acciones operativas)')}
        {item(c.documentario.ok, 'Liquidación documentaria', `${DOC[c.documentario.status] || c.documentario.status}${c.documentario.pending ? ` · ${c.documentario.pending} servicio(s) por completar` : ''}`,
          <button type="button" onClick={() => setDocs(true)} className="font-semibold text-[#002855] underline">Abrir documentos del servicio</button>)}
        {item(c.economico.ok, 'Liquidación económica', ECON[c.economico.status] || c.economico.status,
          <button type="button" onClick={() => setEcon(true)} className="font-semibold text-[#002855] underline">Abrir costos del servicio</button>)}
        {item(c.caja.ok, 'Caja del viaje', c.caja.ok ? 'Sin gastos por revisar' : `${c.caja.pending} gasto(s) por revisar · S/ ${money(Number(c.caja.pending_pen))}`,
          !c.caja.ok && <button type="button" onClick={() => setCaja(true)} className="font-semibold text-[#002855] underline">Revisar gastos del viaje</button>)}
      </div>
      {c.final?.note && <p className="mt-2 text-xs text-slate-600">Motivo: {c.final.note}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!c.final && state.can_close && c.ready && <button type="button" disabled={busy} onClick={() => void act('dispatch_final_close', { p_dispatch_id: dispatchId }, 'Servicio cerrado')}
          className="min-h-10 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50">Cerrar servicio</button>}
        {!c.final && state.can_except && c.operativo.ok && !c.ready && mode !== 'exception' && <button type="button" onClick={() => setMode('exception')}
          className="min-h-10 rounded-lg border border-[#002855] px-4 text-sm font-semibold text-[#002855]">Cerrar con excepción</button>}
        {c.final && state.can_except && mode !== 'reopen' && <button type="button" onClick={() => setMode('reopen')}
          className="min-h-10 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700">Reabrir cierre</button>}
        {!c.final && !c.ready && !state.can_except && c.operativo.ok && <p className="text-xs text-slate-500">El cierre final se habilita cuando los cuatro procesos estén conformes.</p>}
      </div>
      {mode && <div className="mt-2 space-y-2">
        <label className="block text-xs font-semibold text-slate-600">{mode === 'exception' ? 'Motivo de la excepción (queda en el historial)' : 'Motivo de la reapertura'}
          <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} className="mt-1 block w-full rounded-lg border border-slate-300 p-2 text-sm" /></label>
        <div className="flex gap-2">
          <button type="button" disabled={busy || note.trim().length < 10} onClick={() => void (mode === 'exception'
            ? act('dispatch_final_close', { p_dispatch_id: dispatchId, p_note: note, p_exception: true }, 'Servicio cerrado con excepción')
            : act('dispatch_final_reopen', { p_dispatch_id: dispatchId, p_note: note }, 'Cierre final reabierto'))}
            className="min-h-10 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50">Confirmar</button>
          <button type="button" onClick={() => { setMode(null); setNote('') }} className="min-h-10 rounded-lg px-4 text-sm hover:bg-slate-100">Cancelar</button>
        </div>
      </div>}
      {docs && <Modal isOpen onClose={() => { setDocs(false); void load() }} title="Liquidación documentaria del viaje" maxWidth="max-w-6xl">
        <DispatchDocumentarySettlement dispatchId={dispatchId} finalClosed={!!c.final} onChanged={() => { void load(); onChanged?.() }} /></Modal>}
      {caja && <TripExpenses dispatchId={dispatchId} onClose={() => { setCaja(false); void load() }} onChanged={() => { void load(); onChanged?.() }} />}
      {econ && <EconomicClosurePanel dispatchId={dispatchId} onClose={() => setEcon(false)} onChanged={() => { void load(); onChanged?.() }} />}
    </section>
  )
}
