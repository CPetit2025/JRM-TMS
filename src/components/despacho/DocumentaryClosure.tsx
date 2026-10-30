'use client'
import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock, History, Loader2, ShieldCheck } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/caja'

// Cierre documentario por servicio (persistido en la base: documentary_closures). Es independiente del cierre
// económico: dice si la operación quedó documentada, no si los montos están validados.
export type DocumentaryStatus = 'PENDIENTE' | 'EN_VALIDACION' | 'OBSERVADO' | 'COMPLETO'
export type DocumentaryClosure = {
  status: DocumentaryStatus; source: 'AUTOMATICO' | 'MANUAL' | null; completed_at: string | null; completed_by: string | null
  reopened_at: string | null; reopen_reason: string | null; reopened_by: string | null
}
type HistoryEvent = {
  id: string; action: 'INICIAL' | 'AUTOMATICO' | 'CIERRE_MANUAL' | 'DESHACER_MANUAL' | 'REAPERTURA'; previous_status: DocumentaryStatus | null
  new_status: DocumentaryStatus; reason: string | null; created_at: string; actor: string | null
  details: { carga_inicial?: boolean; cierre_manual?: { reason: string; closed_at: string; closed_by_name: string | null } }
}

export const DOCUMENTARY_LABEL: Record<DocumentaryStatus, string> = {
  PENDIENTE: 'Pendiente', EN_VALIDACION: 'En validación', OBSERVADO: 'Observado', COMPLETO: 'Completado',
}
const BADGE: Record<DocumentaryStatus, { text: string; className: string }> = {
  COMPLETO: { text: 'Cierre documentario completado', className: 'bg-emerald-100 text-emerald-800' },
  EN_VALIDACION: { text: 'Cierre documentario en validación', className: 'bg-blue-100 text-blue-800' },
  OBSERVADO: { text: 'Cierre documentario observado', className: 'bg-red-100 text-red-800' },
  PENDIENTE: { text: 'Cierre documentario pendiente', className: 'bg-amber-100 text-amber-900' },
}
const ACTION_LABEL: Record<HistoryEvent['action'], string> = {
  INICIAL: 'Registro inicial', AUTOMATICO: 'Cambio automático', CIERRE_MANUAL: 'Cierre manual', DESHACER_MANUAL: 'Cierre manual deshecho', REAPERTURA: 'Reapertura',
}
const when = (value: string) => new Date(value).toLocaleString('es-PE', { timeZone: 'America/Lima' })

export function DocumentaryBadge({ closure, compact = false }: { closure: DocumentaryClosure; compact?: boolean }) {
  const badge = BADGE[closure.status]
  const Icon = closure.status === 'COMPLETO' ? CheckCircle2 : closure.status === 'OBSERVADO' ? AlertTriangle : closure.status === 'EN_VALIDACION' ? ShieldCheck : Clock
  const origin = closure.status === 'COMPLETO' && closure.source ? ` · ${closure.source === 'MANUAL' ? 'manual' : 'automático'}` : ''
  return <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${badge.className}`}>
    <Icon className="h-3.5 w-3.5 shrink-0" />{compact ? DOCUMENTARY_LABEL[closure.status] : badge.text}{origin}
  </span>
}

// Historial del cierre documentario del servicio (se consulta al abrirlo)
export function DocumentaryHistory({ dispatchId, requestId }: { dispatchId: string; requestId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [events, setEvents] = useState<HistoryEvent[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const load = async () => {
    setLoading(true)
    const { data, error } = await supabase.rpc('get_documentary_closure_history', { p_dispatch: dispatchId, p_request: requestId })
    setLoading(false)
    if (error) { setError(errorMessage(error)); return }
    setError(''); setEvents((data || []) as HistoryEvent[])
  }
  return <details className="rounded-lg bg-white px-3 py-2 text-xs ring-1 ring-slate-200" onToggle={e => { if ((e.target as HTMLDetailsElement).open) void load() }}>
    <summary className="flex cursor-pointer items-center gap-1.5 font-semibold text-[#002855]"><History className="h-3.5 w-3.5" />Historial del cierre documentario{loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}</summary>
    {error && <p className="mt-2 text-red-700">{error}</p>}
    {events && !events.length && <p className="mt-2 text-slate-500">Sin movimientos registrados.</p>}
    {!!events?.length && <ol className="mt-2 space-y-2 border-l border-slate-200 pl-3">
      {events.map(e => <li key={e.id} className="text-slate-700">
        <p><strong>{ACTION_LABEL[e.action]}</strong>{e.previous_status ? ` · ${DOCUMENTARY_LABEL[e.previous_status]} → ` : ' · '}{DOCUMENTARY_LABEL[e.new_status]}
          <span className="text-slate-500"> · {when(e.created_at)} · {e.actor || (e.details.carga_inicial ? 'Carga inicial' : 'Sistema')}</span></p>
        {e.reason && <p className="text-slate-600">Motivo: {e.reason}</p>}
        {e.details.cierre_manual && <p className="text-slate-500">Cierre manual anterior: «{e.details.cierre_manual.reason}»{e.details.cierre_manual.closed_by_name ? ` de ${e.details.cierre_manual.closed_by_name}` : ''} · {when(e.details.cierre_manual.closed_at)}</p>}
      </li>)}
    </ol>}
  </details>
}
