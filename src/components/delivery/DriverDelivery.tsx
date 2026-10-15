'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { arrivalSourceLabel, conformityLabels, deliveryTime, type DeliveryDetail } from '@/lib/delivery'
import { EvidenceForm, type EvidenceDraft } from './EvidenceForm'
import { RejectionForm, type RejectionDraft } from './RejectionForm'
import { readActionQueue, readRouteQueue, routeQueueKey, saveOfflineAction, syncOfflineActions, syncRoutePoints } from '@/lib/route-point-sync'

// Errores que no son Error (GPS del navegador, Supabase): se muestran con su motivo y en español.
const GPS_MESSAGES: Record<number, string> = { 1: 'el permiso de ubicación del app está desactivado', 2: 'el GPS está apagado o sin señal', 3: 'no hubo señal GPS a tiempo' }
export function readableError(err: unknown, fallback: string) {
  if (err instanceof Error && err.message) return err.message
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code
    if (typeof GeolocationPositionError !== 'undefined' && err instanceof GeolocationPositionError) return `Ubicación no disponible: ${GPS_MESSAGES[err.code] || err.message}.`
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string' && message) return typeof code === 'string' && code ? `${message} (${code})` : message
  }
  return fallback
}
const gpsPosition = (options: PositionOptions) => new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, options))
// Ubicación de la entrega: alta precisión y, si no llega, la última lectura aproximada. Si no hay GPS, la guía se envía igual:
// el servidor usa el último punto del despacho y marca el tramo como «GPS incompleto».
async function deliveryPosition(): Promise<GeolocationPosition | null> {
  if (!('geolocation' in navigator)) return null
  try { return await gpsPosition({ enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }) }
  catch { try { return await gpsPosition({ enableHighAccuracy: false, maximumAge: 120000, timeout: 8000 }) } catch { return null } }
}

const asBase64 = (file: File) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('No se pudo guardar la foto en el dispositivo')); reader.readAsDataURL(file) })
export function DriverDelivery({ dispatchId, requestId, driverId, userId, guide, documentaryOnly = false, onChanged }: {
  dispatchId: string; requestId: string; driverId: string; userId: string; guide?: string; documentaryOnly?: boolean; onChanged: () => Promise<void>
}) {
  const db = useMemo(() => createClient(), [])
  const [detail, setDetail] = useState<DeliveryDetail | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [queued, setQueued] = useState(false)
  const [rejecting, setRejecting] = useState(false), [rejectionQueued, setRejectionQueued] = useState(false), [loadedAt, setLoadedAt] = useState(0)
  const load = useCallback(async () => {
    const pending = readActionQueue().filter(action => action.payload.dispatch_id === dispatchId && action.payload.request_id === requestId)
    setQueued(pending.some(action => action.type === 'delivery_submit_driver'))
    setRejectionQueued(pending.some(action => action.type === 'delivery_reject_driver'))
    const { data, error } = await db.rpc('delivery_get', { p_dispatch: dispatchId, p_request: requestId })
    if (error) { setError(error.message); return }
    setDetail(data as DeliveryDetail); setLoadedAt(Date.now()); setError('')
  }, [db, dispatchId, requestId])
  useEffect(() => { const initial = window.setTimeout(() => void load(), 0); const timer = window.setInterval(() => void load(), 15000); return () => { window.clearTimeout(initial); window.clearInterval(timer) } }, [load])
  const submit = async (draft: EvidenceDraft) => {
    setBusy(true); setError('')
    try {
      let capturedAt = new Date().toISOString()
      const position = documentaryOnly ? null : await deliveryPosition()
      // El punto de la entrega solo se registra si es preciso y reciente (una lectura vieja llegaría fuera de orden)
      if (position && position.coords.accuracy <= 30 && Date.now() - position.timestamp <= 15000) {
        const points = readRouteQueue()
        capturedAt = new Date(position.timestamp).toISOString()
        points.push({ id: crypto.randomUUID(), dispatch_id: dispatchId, driver_id: driverId, recorded_at: capturedAt, latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy_m: position.coords.accuracy, speed_mps: position.coords.speed })
        localStorage.setItem(routeQueueKey, JSON.stringify(points))
      }
      // Primero guarda todas las fotos y la operación; nunca adelanta el estado local.
      const photos = await Promise.all(draft.files.map(asBase64))
      const packing = await Promise.all(draft.packingFiles.map(asBase64))
      saveOfflineAction('delivery_submit_driver', { dispatch_id: dispatchId, request_id: requestId, user_id: userId, photos_base64: photos, packing_base64: packing, received_by: draft.receiver, guide: draft.guide, note: draft.note, captured_at: capturedAt }, draft.operation)
      setQueued(true)
      if (navigator.onLine) { await syncRoutePoints(); await syncOfflineActions() }
      await load(); await onChanged()
    } catch (err) { const message = readableError(err, 'No se pudo enviar la guía. Revise la conexión e intente de nuevo.'); setError(message); throw new Error(message) }
    finally { setBusy(false) }
  }
  // Rechazo en destino: se guarda primero en el teléfono (fotos y GPS) y se envía al haber señal
  const reject = async (draft: RejectionDraft) => {
    setBusy(true); setError('')
    try {
      const position = await deliveryPosition()
      const photos = await Promise.all(draft.files.map(asBase64))
      saveOfflineAction('delivery_reject_driver', { dispatch_id: dispatchId, request_id: requestId, user_id: userId, kind: draft.kind, reason: draft.reason, note: draft.note,
        photos_base64: photos, latitude: position?.coords.latitude ?? null, longitude: position?.coords.longitude ?? null,
        accuracy_m: position ? Math.round(position.coords.accuracy) : null, captured_at: new Date().toISOString() }, draft.operation)
      setRejecting(false); setRejectionQueued(true)
      if (navigator.onLine) await syncOfflineActions()
      await load(); await onChanged()
      window.dispatchEvent(new Event('jrm:trip-changed'))
    } catch (err) { const message = readableError(err, 'No se pudo registrar el rechazo. Revise la conexión e intente de nuevo.'); setError(message); throw new Error(message) }
    finally { setBusy(false) }
  }
  // Llegada con la ubicación del teléfono (si no hay GPS se registra igual, sin punto)
  const arrive = async () => {
    setBusy(true); setError('')
    const position = await deliveryPosition()
    const { error } = await db.rpc('delivery_arrive_at', { p_dispatch: dispatchId, p_request: requestId, p_lat: position?.coords.latitude ?? null,
      p_lon: position?.coords.longitude ?? null, p_accuracy: position ? Math.round(position.coords.accuracy) : null, p_source: 'MANUAL' })
    if (error) setError(readableError(error, 'No se pudo registrar la llegada')); else { await load(); window.dispatchEvent(new Event('jrm:trip-changed')) }
    setBusy(false)
  }
  const undoArrival = async () => {
    setBusy(true); setError('')
    const { error } = await db.rpc('delivery_arrive_undo', { p_dispatch: dispatchId, p_request: requestId })
    if (error) setError(readableError(error, 'No se pudo deshacer la llegada')); else { await load(); window.dispatchEvent(new Event('jrm:trip-changed')) }
    setBusy(false)
  }
  const retry = async () => {
    setBusy(true)
    try { await syncRoutePoints(); await syncOfflineActions(); await load(); await onChanged() }
    catch (err) { setError(readableError(err, 'No se pudo sincronizar. Revise la conexión e intente de nuevo.')) }
    finally { setBusy(false) }
  }
  const correction = detail?.submissions[0]?.review?.reason
  const rejection = detail?.rejection
  const autoArrival = detail?.arrival_source === 'AUTO_GEOCERCA' && !!detail.arrived_at && loadedAt - new Date(detail.arrived_at).getTime() < 30 * 60_000
  const canReject = !documentaryOnly && !!detail && ['PENDIENTE', 'OBSERVADA', 'RECHAZADA'].includes(detail.state) && rejection?.kind !== 'TOTAL'
  if (rejectionQueued || detail?.state === 'RECHAZO_DESTINO') return <div className="space-y-2">
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {detail?.state === 'RECHAZO_DESTINO' && rejection ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
      <p className="font-semibold">Entrega rechazada en destino</p>
      <p className="mt-1">{rejection.reason}{rejection.note ? ` · ${rejection.note}` : ''} · {deliveryTime(rejection.captured_at)}</p>
      <p className="mt-1 text-xs">{rejection.decision === 'REPROGRAMADA' ? `Despacho la reprogramó${rejection.required_date ? ` para el ${rejection.required_date.split('-').reverse().join('/')}` : ''}.` : rejection.decision === 'ANULADA' ? 'Despacho anuló el servicio.' : 'Despacho fue avisado y decidirá si se reprograma o se anula. Continúa con tu siguiente parada.'}</p>
    </div> : <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900"><p>Rechazo guardado en este dispositivo. Envío pendiente.</p>
      <p className="mt-1 text-xs">{readActionQueue().find(action => action.type === 'delivery_reject_driver' && action.payload.request_id === requestId)?.last_error || 'Se enviará al recuperar la señal.'}</p>
      <button disabled={busy} onClick={() => void retry()} className="mt-2 min-h-11 rounded-lg border border-amber-300 px-3 font-semibold">Reintentar envío</button></div>}
  </div>
  return <div className="space-y-3">
    <p className="text-sm font-semibold text-[#002855]">Guía de remisión y Packing List</p>
    <p className="text-xs leading-5 text-slate-600">Adjunta la guía firmada por el cliente y, si el servicio lo tiene, el Packing List. El Supervisor de Transporte aprueba la guía para habilitar la siguiente etapa.</p>
    {documentaryOnly && <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900">Ruta liberada por el corte diario. Completa el sustento pendiente; esta carga no registra una llegada ni modifica el recorrido GPS.</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {!detail && !queued ? <p className="text-sm text-slate-500">Verificando conformidad… <button onClick={() => void load()} className="min-h-10 text-blue-700">Actualizar</button></p> : queued ? <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900"><p>Guía guardada en este dispositivo. Envío pendiente; el servicio continúa bloqueado.</p><p className="mt-1 text-xs">{readActionQueue().find(action => action.type === 'delivery_submit_driver' && action.payload.request_id === requestId)?.last_error || 'Se requiere conexión para confirmar la recepción.'}</p><button disabled={busy} onClick={() => void retry()} className="mt-2 min-h-11 rounded-lg border border-amber-300 px-3 font-semibold">Reintentar envío</button></div> : detail?.state === 'RECIBIDA' ? <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Guía recibida. Pendiente de validación del Supervisor de Transporte. La siguiente etapa se habilita al aprobarla.</p> : detail?.state === 'VALIDADA' ? <p className="text-sm text-emerald-700">Conformidad aprobada.</p> : <>
      {correction && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{conformityLabels[detail?.state || 'PENDIENTE']}: {correction}</p>}
      {!documentaryOnly && !detail?.arrived_at && <button disabled={busy || !navigator.onLine} className="min-h-11 rounded-lg border border-amber-300 px-3 text-sm" onClick={() => void arrive()}>Confirmar llegada al destino</button>}
      {!documentaryOnly && detail?.arrived_at && <p className="text-xs text-slate-600">Llegada {deliveryTime(detail.arrived_at)} · {arrivalSourceLabel(detail.arrival_source)}{autoArrival && <button disabled={busy} onClick={() => void undoArrival()} className="ml-2 min-h-9 font-semibold text-blue-700 underline">Deshacer</button>}</p>}
      {rejection?.kind === 'PARCIAL' && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">Rechazo parcial registrado: {rejection.reason}{rejection.note ? ` · ${rejection.note}` : ''}. Envía la guía firmada de lo que sí se entregó.</p>}
      {rejecting ? <RejectionForm busy={busy} onSubmit={reject} onCancel={() => setRejecting(false)} /> : <>
        <EvidenceForm key={detail?.submissions[0]?.id || requestId} busy={busy} guide={guide} onSubmit={submit} />
        {canReject && <button type="button" disabled={busy} onClick={() => setRejecting(true)} className="min-h-11 w-full rounded-lg border border-red-200 px-3 text-sm font-semibold text-red-800">¿No se pudo entregar? Registrar rechazo en destino</button>}
      </>}
    </>}
  </div>
}
