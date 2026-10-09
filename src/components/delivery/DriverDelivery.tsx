'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { conformityLabels, type DeliveryDetail } from '@/lib/delivery'
import { EvidenceForm, type EvidenceDraft } from './EvidenceForm'
import { readActionQueue, readRouteQueue, routeQueueKey, saveOfflineAction, syncOfflineActions, syncRoutePoints } from '@/lib/route-point-sync'

const asBase64 = (file: File) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('No se pudo guardar la foto en el dispositivo')); reader.readAsDataURL(file) })
export function DriverDelivery({ dispatchId, requestId, driverId, userId, guide, onChanged }: {
  dispatchId: string; requestId: string; driverId: string; userId: string; guide?: string; onChanged: () => Promise<void>
}) {
  const db = useMemo(() => createClient(), [])
  const [detail, setDetail] = useState<DeliveryDetail | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [queued, setQueued] = useState(false)
  const load = useCallback(async () => {
    setQueued(readActionQueue().some(action => action.type === 'delivery_submit_driver' && action.payload.dispatch_id === dispatchId && action.payload.request_id === requestId))
    const { data, error } = await db.rpc('delivery_get', { p_dispatch: dispatchId, p_request: requestId })
    if (error) { setError(error.message); return }
    setDetail(data as DeliveryDetail); setError('')
  }, [db, dispatchId, requestId])
  useEffect(() => { const initial = window.setTimeout(() => void load(), 0); const timer = window.setInterval(() => void load(), 15000); return () => { window.clearTimeout(initial); window.clearInterval(timer) } }, [load])
  const submit = async (draft: EvidenceDraft) => {
    setBusy(true); setError('')
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }))
      if (position.coords.accuracy > 30) throw new Error('Espere una señal GPS de 30 m o mejor.')
      const points = readRouteQueue()
      const capturedAt = new Date(position.timestamp).toISOString()
      points.push({ id: crypto.randomUUID(), dispatch_id: dispatchId, driver_id: driverId, recorded_at: capturedAt, latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy_m: position.coords.accuracy, speed_mps: position.coords.speed })
      localStorage.setItem(routeQueueKey, JSON.stringify(points))
      // Primero guarda todas las fotos y la operación; nunca adelanta el estado local.
      const photos = await Promise.all(draft.files.map(asBase64))
      const packing = await Promise.all(draft.packingFiles.map(asBase64))
      saveOfflineAction('delivery_submit_driver', { dispatch_id: dispatchId, request_id: requestId, user_id: userId, photos_base64: photos, packing_base64: packing, received_by: draft.receiver, guide: draft.guide, note: draft.note, captured_at: capturedAt }, draft.operation)
      setQueued(true)
      if (navigator.onLine) { await syncRoutePoints(); await syncOfflineActions() }
      await load(); await onChanged()
    } catch (err) { const message = err instanceof Error ? err.message : 'No se pudo enviar la guía'; setError(message); throw new Error(message) }
    finally { setBusy(false) }
  }
  const retry = async () => {
    setBusy(true)
    try { await syncRoutePoints(); await syncOfflineActions(); await load(); await onChanged() }
    catch (err) { setError(err instanceof Error ? err.message : 'No se pudo sincronizar') }
    finally { setBusy(false) }
  }
  const correction = detail?.submissions[0]?.review?.reason
  return <div className="space-y-3">
    <p className="text-sm font-semibold text-[#002855]">Guía de remisión y Packing List</p>
    <p className="text-xs leading-5 text-slate-600">Adjunta la guía firmada por el cliente y, si el servicio lo tiene, el Packing List. El Supervisor de Transporte aprueba la guía para habilitar la siguiente etapa.</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {!detail && !queued ? <p className="text-sm text-slate-500">Verificando conformidad… <button onClick={() => void load()} className="min-h-10 text-blue-700">Actualizar</button></p> : queued ? <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900"><p>Guía guardada en este dispositivo. Envío pendiente; el servicio continúa bloqueado.</p><p className="mt-1 text-xs">{readActionQueue().find(action => action.type === 'delivery_submit_driver' && action.payload.request_id === requestId)?.last_error || 'Se requiere conexión para confirmar la recepción.'}</p><button disabled={busy} onClick={() => void retry()} className="mt-2 min-h-11 rounded-lg border border-amber-300 px-3 font-semibold">Reintentar envío</button></div> : detail?.state === 'RECIBIDA' ? <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Guía recibida. Pendiente de validación del Supervisor de Transporte. La siguiente etapa se habilita al aprobarla.</p> : detail?.state === 'VALIDADA' ? <p className="text-sm text-emerald-700">Conformidad aprobada.</p> : <>
      {correction && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{conformityLabels[detail?.state || 'PENDIENTE']}: {correction}</p>}
      {!detail?.arrived_at && <button disabled={busy || !navigator.onLine} className="min-h-11 rounded-lg border border-amber-300 px-3 text-sm" onClick={async () => { setBusy(true); const { error } = await db.rpc('delivery_arrive', { p_dispatch: dispatchId, p_request: requestId }); if (error) setError(error.message); else await load(); setBusy(false) }}>Confirmar llegada al destino</button>}
      <EvidenceForm key={detail?.submissions[0]?.id || requestId} busy={busy} guide={guide} onSubmit={submit} />
    </>}
  </div>
}
