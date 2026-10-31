'use client'

import { useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'

const eligible = ['PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO', 'ENTREGADO']

export function ManualOperationalCloseButton({ dispatchId, onClosed, status, dispatchNumber }: {
  dispatchId: string
  onClosed: () => void
  status?: string
  dispatchNumber?: string
}) {
  const { canWrite } = usePermissions()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  if (!(canWrite('despacho') || canWrite('monitoreo') || canWrite('torre-control')) || (status && !eligible.includes(status))) return null
  const close = () => { if (!pending.current) { setOpen(false); setError('') } }
  const submit = async () => {
    const trimmed = reason.trim()
    if (pending.current || trimmed.length < 10 || trimmed.length > 500) return
    pending.current = true; setBusy(true); setError('')
    try {
      const { data, error: failure } = await createClient().rpc('manual_close_dispatch_operations', { p_dispatch: dispatchId, p_reason: trimmed })
      if (failure) throw failure
      if (!data?.success) throw new Error(data?.error || 'No se pudo cerrar la operación.')
      setOpen(false); setReason(''); onClosed()
    } catch (failure) {
      setError((failure as { message?: string }).message || 'No se pudo cerrar la operación. Reintenta la acción.')
    } finally { pending.current = false; setBusy(false) }
  }
  return <>
    <button type="button" onClick={() => { setReason(''); setError(''); setOpen(true) }} className="min-h-11 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">Cierre operativo manual</button>
    <Modal isOpen={open} onClose={close} title={`Cierre operativo manual${dispatchNumber ? ` · ${dispatchNumber}` : ''}`} maxWidth="max-w-xl"
      footer={<div className="flex flex-wrap justify-end gap-2"><button type="button" disabled={busy} onClick={close} className="min-h-11 rounded-lg border px-4 py-2 text-sm">Cancelar</button><button type="button" disabled={busy || reason.trim().length < 10 || reason.trim().length > 500} onClick={() => { void submit() }} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#002855] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" />}{busy ? 'Cerrando…' : 'Confirmar cierre operativo'}</button></div>}>
      <div className="space-y-4">
        <p className="text-sm text-slate-700">Se finalizará la operación de esta ruta y se liberarán sus recursos cuando corresponda. Las guías, conformidades y el cierre económico mantendrán su estado actual.</p>
        {status === 'PROGRAMADO' && <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">La ruta figura sin salida. Si el servicio <b>no se realizó</b>, use «Cancelar ruta»: libera la reserva y devuelve las solicitudes a programación. Cierre aquí solo si se ejecutó sin registrar la salida; su costo quedará pendiente en Cierre económico.</p>}
        <label className="block space-y-1 text-sm font-medium text-slate-800"><span>Explicación del cierre *</span><textarea aria-label="Explicación del cierre operativo" value={reason} onChange={event => setReason(event.target.value)} disabled={busy} minLength={10} maxLength={500} rows={4} className="w-full rounded-lg border border-slate-300 px-3 py-2 font-normal" placeholder="Describe brevemente por qué corresponde cerrar esta operación." /><span className="block text-xs font-normal text-slate-500">De 10 a 500 caracteres. Se guardará en la bitácora con responsable, fecha y estado anterior.</span></label>
        {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      </div>
    </Modal>
  </>
}
