'use client'

import { useMemo, useRef, useState } from 'react'
import { CheckCircle2, Loader2, PlayCircle } from 'lucide-react'
import { toast } from 'sonner'
import { usePermissions } from '@/hooks/usePermissions'
import { createClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/caja'
import { dispatchClosureMessage, dispatchExecutionAction } from '@/lib/dispatch-execution'

export function DispatchExecutionActions({ dispatch, onChanged }: {
  dispatch: { id: string; status: string; modalidad?: string | null }
  onChanged: () => void | Promise<void>
}) {
  const db = useMemo(() => createClient(), [])
  const { canWrite } = usePermissions()
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const action = dispatchExecutionAction(dispatch.status, dispatch.modalidad)
  if (!canWrite('despacho') || !action) return null

  const execute = async () => {
    if (running.current || !canWrite('despacho')) return
    running.current = true
    setBusy(true)
    try {
      // The server owns Packing List/Nota, driver readiness and destination conformity gates.
      // A signed destination guide must never be required by this client before departure.
      const result = action.rpc === 'close_dispatch_route'
        ? await db.rpc('close_dispatch_route', { p_dispatch_id: dispatch.id })
        : await db.rpc('transition_dispatch_status', {
          p_dispatch_id: dispatch.id, p_new_status: action.nextStatus, p_reason: action.reason,
        })
      if (result.error) throw result.error
      if (result.data?.success === false) throw new Error(result.data.error || 'No se pudo completar la operación')
      toast.success(action.rpc === 'close_dispatch_route'
        ? dispatchClosureMessage(result.data || {}, dispatch.modalidad)
        : action.nextStatus === 'RETORNO'
          ? 'Retorno autorizado.'
          : dispatch.modalidad === 'RECOJO_CLIENTE'
            ? 'Retiro preparado. El recojo por cliente no utiliza seguimiento GPS de transporte JRM.'
            : 'Salida preparada. El seguimiento GPS comenzará cuando el conductor inicie la operación desde la app.')
      await onChanged()
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      running.current = false
      setBusy(false)
    }
  }

  return <button type="button" disabled={busy} onClick={() => void execute()}
    className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white hover:bg-[#001d3d] disabled:opacity-50">
    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : action.rpc === 'close_dispatch_route' ? <CheckCircle2 className="h-4 w-4" /> : <PlayCircle className="h-4 w-4" />}
    {action.label}
  </button>
}
