'use client'
import { useCallback, useEffect, useState } from 'react'
import { Loader2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { errorMessage, money } from '@/lib/caja'

// Bandeja de desvíos del control presupuestal (etapa 4, flujo F4): el Supervisor sustenta, el Jefe de Distribución
// recomienda y decide dentro de sus atribuciones; lo que toca el margen protegido lo decide Gerencia de Operaciones.
// Aprobar no cambia el presupuesto; rechazar devuelve el costo a corrección o registra la acción correctiva.

type Deviation = {
  key: string; kind: 'COSTO_SOBRE_ACORDADO' | 'OT_SOBRE_TOPE' | 'EMERGENCIA_SIN_RATIFICAR'; code: string | null; amount_pen: number; label: string
  since: string | null; status: 'PENDIENTE_SUSTENTO' | 'SUSTENTADO' | 'RECOMENDADO' | 'APROBADO' | 'RECHAZADO'; needs_management: boolean
  support_note: string | null; support_evidence: string | null; supported_by: string | null; recommend: boolean | null; recommendation: string | null
  recommended_by: string | null
}
type History = { key: string; kind: Deviation['kind']; code: string | null; amount_pen: number; status: string; decision_note: string | null; decided_by: string | null; decided_at: string }
type List = { settings: { max_pending_days?: number }; can_support: boolean; can_recommend: boolean; can_authorize: boolean; open: Deviation[]; history: History[] }

const supabase = createClient()
const KIND: Record<Deviation['kind'], string> = { COSTO_SOBRE_ACORDADO: 'Costo sobre lo acordado', OT_SOBRE_TOPE: 'OT sobre el tope', EMERGENCIA_SIN_RATIFICAR: 'Emergencia sin ratificar' }
const STATUS: Record<Deviation['status'], [string, string]> = {
  PENDIENTE_SUSTENTO: ['Pendiente de sustento', 'bg-amber-100 text-amber-800'], SUSTENTADO: ['Sustentado', 'bg-blue-100 text-blue-800'],
  RECOMENDADO: ['Recomendado', 'bg-violet-100 text-violet-800'], APROBADO: ['Aprobado', 'bg-emerald-100 text-emerald-800'], RECHAZADO: ['Rechazado', 'bg-red-100 text-red-700'],
}
const days = (v: string | null) => (v ? Math.max(0, Math.floor((Date.now() - Date.parse(v)) / 86400000)) : null)

export function BudgetDeviations({ onChanged }: { onChanged: () => void }) {
  const [list, setList] = useState<List | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('budget_deviations_list')
    if (error || !data?.success) { toast.error(error ? errorMessage(error) : data?.error); return }
    setList(data as List)
  }, [])
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [load])

  const act = async (d: Deviation, action: string, ask?: string, askEvidence = false) => {
    let note: string | null = null, evidence: string | null = null
    if (ask) { note = window.prompt(ask); if (note === null) return }
    if (askEvidence) evidence = window.prompt('Evidencia (enlace, número de documento; opcional)') || null
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('budget_deviation_action', { p_key: d.key, p_action: action, p_note: note, p_evidence: evidence })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error)
      toast.success(`${KIND[d.kind]}: ${STATUS[data.status as Deviation['status']]?.[0].toLowerCase() || 'listo'}`); void load(); onChanged()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }

  const btn = 'rounded border px-2 py-0.5 text-xs font-semibold disabled:opacity-50'
  const late = list?.settings.max_pending_days ?? 7
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-3">
      <h2 className="flex items-center gap-2 font-bold text-slate-800"><TriangleAlert className="h-4 w-4" />Desvíos {list ? `(${list.open.length})` : ''}</h2>
      <p className="text-[11px] text-slate-500">Solo lo que se sale del presupuesto o de lo acordado. Lo conforme se cierra solo.</p>
      {!list ? <Loader2 className="mt-2 h-4 w-4 animate-spin text-slate-400" /> : !list.open.length ? <p className="mt-2 text-sm text-slate-500">Sin desvíos pendientes.</p> :
        <ul className="mt-2 space-y-2">{list.open.map(d => {
          const age = days(d.since), decide = d.needs_management ? list.can_authorize : (list.can_recommend || list.can_authorize)
          return <li key={d.key} className="rounded-lg border border-slate-200 p-2 text-sm">
            <div className="flex flex-wrap items-center gap-2"><b className="text-slate-800">{KIND[d.kind]}</b>
              <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${STATUS[d.status][1]}`}>{STATUS[d.status][0]}</span>
              {d.needs_management && <span className="rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-semibold text-red-700">Decide Gerencia</span>}
              <span className="tabular-nums">S/ {money(Number(d.amount_pen))}</span>
              {age != null && <span className={`text-xs ${age > late ? 'font-semibold text-red-700' : 'text-slate-500'}`}>{age} día(s)</span>}</div>
            <p className="text-xs text-slate-700">{d.label}</p>
            {d.support_note && <p className="text-xs text-slate-600">Sustento ({d.supported_by}): {d.support_note}{d.support_evidence ? ` · ${d.support_evidence}` : ''}</p>}
            {d.recommend != null && <p className="text-xs text-slate-600">Jefe ({d.recommended_by}): {d.recommend ? 'recomienda aprobar' : 'no recomienda'}{d.recommendation ? ` · ${d.recommendation}` : ''}</p>}
            <div className="mt-1 flex flex-wrap gap-1">
              {list.can_support && d.status === 'PENDIENTE_SUSTENTO' && d.kind !== 'EMERGENCIA_SIN_RATIFICAR' &&
                <button type="button" disabled={busy} onClick={() => void act(d, 'SUSTENTAR', 'Causa del desvío (mínimo 10 caracteres)', true)} className={`${btn} border-[#002855] text-[#002855]`}>Sustentar</button>}
              {list.can_recommend && d.status === 'SUSTENTADO' && <>
                <button type="button" disabled={busy} onClick={() => void act(d, 'RECOMENDAR', 'Comentario (opcional)')} className={`${btn} border-blue-300 text-blue-800`}>Recomendar aprobar</button>
                <button type="button" disabled={busy} onClick={() => void act(d, 'NO_RECOMENDAR', 'Por qué no se recomienda')} className={`${btn} border-red-300 text-red-700`}>No recomendar</button></>}
              {decide && (d.status !== 'PENDIENTE_SUSTENTO' || d.kind === 'EMERGENCIA_SIN_RATIFICAR') && <>
                <button type="button" disabled={busy} onClick={() => void act(d, 'APROBAR', 'Nota (opcional)')} className={`${btn} border-emerald-400 bg-emerald-600 text-white`}>{d.kind === 'EMERGENCIA_SIN_RATIFICAR' ? 'Ratificar' : 'Aprobar'}</button>
                <button type="button" disabled={busy} onClick={() => void act(d, 'RECHAZAR', d.kind === 'COSTO_SOBRE_ACORDADO' ? 'Acción correctiva (el costo vuelve a corrección)' : 'Acción correctiva')} className={`${btn} border-red-300 text-red-700`}>Rechazar</button></>}
            </div>
          </li>
        })}</ul>}
      {!!list?.history.length && <details className="mt-2"><summary className="cursor-pointer text-xs font-semibold text-slate-600">Resueltos (90 días): {list.history.length}</summary>
        <ul className="mt-1 space-y-1 text-xs">{list.history.map(h => <li key={h.key + h.decided_at} className="border-l-2 border-slate-200 pl-2">
          {KIND[h.kind]}{h.code ? ` · OT ${h.code}` : ''} · S/ {money(Number(h.amount_pen))} · <b>{h.status.toLowerCase()}</b> por {h.decided_by} · {new Date(h.decided_at).toLocaleDateString('es-PE')}{h.decision_note ? ` · ${h.decision_note}` : ''}</li>)}</ul></details>}
    </section>
  )
}
