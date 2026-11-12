'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PackageCheck, PackageX } from 'lucide-react'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { createClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/caja'

// Liberación del almacén (picking + auditoría en el WMS). La base bloquea la SALIDA de despachos APT sin liberación
// (wms_release_departure_guard); aquí solo se muestra el estado y la excepción del supervisor.
export type WmsRelease = {
  id: string; request_number: string; required: boolean; blocked: boolean; state?: string; label?: string
  released_at?: string | null; override?: { reason: string; at: string; by: string } | null
}
type Status = { items: Record<string, WmsRelease>; canOverride: boolean; reload: () => void }

/** Estado WMS de varias solicitudes (Solicitudes, Programación) o de las solicitudes de un despacho (salida). */
export function useWmsRelease({ requests, dispatch }: { requests?: string[]; dispatch?: string | null }): Status {
  const db = useMemo(() => createClient(), [])
  const key = dispatch || (requests || []).slice().sort().join(',')
  const [state, setState] = useState<{ key: string; items: Record<string, WmsRelease>; canOverride: boolean }>({ key: '', items: {}, canOverride: false })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!key) return
    let alive = true
    void Promise.resolve(db.rpc('wms_release_status', dispatch ? { p_requests: null, p_dispatch: dispatch } : { p_requests: key.split(','), p_dispatch: null }))
      .then(({ data }) => {
        if (!alive || !data?.success) return
        setState({ key, canOverride: !!data.can_override, items: Object.fromEntries((data.items as WmsRelease[]).map(i => [i.id, i])) })
      })
    return () => { alive = false }
  }, [db, key, dispatch, tick])
  const reload = useCallback(() => setTick(t => t + 1), [])
  return { items: state.key === key ? state.items : {}, canOverride: state.canOverride, reload }
}

const TONE: Record<string, string> = {
  LIBERADO: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  SIN_RESPUESTA: 'bg-red-50 text-red-800 ring-red-200',
  OBSERVADO: 'bg-red-50 text-red-800 ring-red-200',
  CANCELADO: 'bg-red-50 text-red-800 ring-red-200',
}

/** Insignia «WMS: …» de una solicitud; nada si la solicitud no pasa por el almacén APT. */
export function WmsReleaseBadge({ item, canOverride, onChanged }: { item?: WmsRelease; canOverride?: boolean; onChanged?: () => void }) {
  const [open, setOpen] = useState(false)
  if (!item?.required) return null
  const text = item.override ? 'Salida autorizada sin WMS' : item.label
  const tone = item.override ? 'bg-amber-50 text-amber-800 ring-amber-200' : TONE[item.state || ''] || 'bg-slate-100 text-slate-700 ring-slate-200'
  const title = item.override ? `Excepción de ${item.override.by}: ${item.override.reason}`
    : item.blocked ? 'Se puede asignar y programar; la salida espera la liberación del almacén (picking y auditoría en el WMS).' : 'Liberada por el almacén'
  return <>
    <span className={`mt-0.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${tone}`} title={title}>
      {item.blocked ? <PackageX aria-hidden className="h-3 w-3" /> : <PackageCheck aria-hidden className="h-3 w-3" />}WMS: {text}
    </span>
    {item.blocked && canOverride && <button type="button" onClick={() => setOpen(true)} className="ml-1 text-[11px] font-semibold text-red-700 underline">Autorizar salida</button>}
    {open && <WmsOverrideModal item={item} onClose={() => setOpen(false)} onDone={() => { setOpen(false); onChanged?.() }} />}
  </>
}

function WmsOverrideModal({ item, onClose, onDone }: { item: WmsRelease; onClose: () => void; onDone: () => void }) {
  const db = useMemo(() => createClient(), [])
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      const { data, error } = await db.rpc('wms_release_override', { p_request: item.id, p_reason: reason })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error || 'No se registró la excepción')
      toast.success(`Salida de ${item.request_number} autorizada sin liberación del WMS`)
      onDone()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  return <Modal isOpen onClose={onClose} title={`Autorizar salida sin WMS · ${item.request_number}`}
    footer={<div className="flex justify-end gap-2">
      <button type="button" onClick={onClose} className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold">Cancelar</button>
      <button type="button" disabled={busy || reason.trim().length < 20} onClick={() => void save()}
        className="min-h-11 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50">Autorizar salida</button>
    </div>}>
    <div className="space-y-3 text-sm">
      <p className="text-slate-600">Solo para emergencias. Estado actual en el WMS: <b>{item.label}</b>. La excepción queda registrada con su usuario, la hora y el motivo.</p>
      <label className="block font-medium">Motivo (mínimo 20 caracteres)
        <textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} maxLength={1000} className="mt-1 w-full rounded-lg border border-slate-300 p-3" />
      </label>
    </div>
  </Modal>
}

/** Aviso de salida bloqueada de un despacho (Torre, detalle y app del conductor). Devuelve si está bloqueado. */
export function WmsDepartureNotice({ dispatchId, onBlocked }: { dispatchId: string; onBlocked?: (blocked: boolean) => void }) {
  const { items, canOverride, reload } = useWmsRelease({ dispatch: dispatchId })
  const blocked = Object.values(items).filter(i => i.blocked)
  useEffect(() => { onBlocked?.(blocked.length > 0) }, [blocked.length, onBlocked])
  if (!blocked.length) return null
  return <div role="status" className="rounded-lg border border-red-200 bg-red-50 p-3 text-left text-sm text-red-800">
    <p className="flex items-center gap-2 font-semibold"><PackageX aria-hidden className="h-4 w-4" />Salida bloqueada: falta la liberación del almacén</p>
    <ul className="mt-1 space-y-1">
      {blocked.map(i => <li key={i.id}>{i.request_number}: aún no liberada (picking y auditoría en el WMS) · Estado WMS: {i.label}
        {canOverride && <WmsReleaseBadge item={i} canOverride onChanged={reload} />}</li>)}
    </ul>
  </div>
}
