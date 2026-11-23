'use client'

import { useCallback, useEffect, useState } from 'react'
import { Camera, Gauge } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { compressPhoto } from '@/lib/delivery'
import { syncWorkdayReminder } from '@/lib/workday-reminder'
import { actionQueueKey, isPermanentSyncError, readActionQueue, saveOfflineAction, syncOfflineActions } from '@/lib/route-point-sync'

type State = { own_unit: boolean; start_odometer: number | null; end_odometer: number | null; km: number | null; gps_km: number | null; km_check: string | null }
const asBase64 = (file: File) => new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error('No se pudo leer la foto')); r.readAsDataURL(file) })

/** Al volver a base: cierra la jornada del día con la misma lectura de llegada, sin ir a otra pantalla. */
function CloseDayHere({ odometer }: { odometer: number }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [msg, setMsg] = useState('')
  useEffect(() => {
    void createClient().rpc('get_driver_workday').then(({ data }) => setOpen(!!(data?.success && data.start && !data.close && odometer >= Number(data.start.odometer))))
  }, [odometer])
  if (!open && !msg) return null
  const close = async () => {
    setBusy(true)
    try {
      const { data, error } = await createClient().rpc('close_driver_workday', { p_operation: crypto.randomUUID(), p_odometer: String(odometer), p_photo: null, p_captured_at: new Date().toISOString() })
      if (error || !data?.success) throw error || new Error(data?.error || 'No se pudo cerrar la jornada')
      setOpen(false); setMsg(data.km != null ? `Jornada cerrada: ${Number(data.km).toLocaleString('es-PE')} km hoy` : 'Jornada cerrada')
      void syncWorkdayReminder(false)
    } catch (e) { setMsg(e instanceof Error ? e.message : 'No se pudo cerrar la jornada') } finally { setBusy(false) }
  }
  return <div className="mt-2 space-y-1">
    {open && <button type="button" disabled={busy} onClick={() => void close()} className="min-h-11 w-full rounded-lg border border-[#002855] px-3 font-semibold text-[#002855] disabled:opacity-50">{busy ? 'Cerrando…' : `¿Terminaste el día? Cerrar jornada con ${odometer.toLocaleString('es-PE')} km`}</button>}
    {msg && <p className="text-slate-700">{msg}</p>}
  </div>
}

/** Odómetro con foto del tablero al salir y al volver (unidades propias). Avisa con onReady cuando la lectura está registrada o en cola. */
export function TripOdometer({ dispatchId, userId, kind, onReady }: { dispatchId: string; userId: string; kind: 'SALIDA' | 'LLEGADA'; onReady: (ready: boolean) => void }) {
  const [state, setState] = useState<State | null>(null), [value, setValue] = useState(''), [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  // Lectura guardada en el teléfono que aún se enviará (pendiente o con error de red; no un rechazo definitivo)
  const queued = useCallback(() => readActionQueue().find(a => a.type === 'dispatch_odometer' && a.payload.dispatch_id === dispatchId && a.payload.kind === kind && !isPermanentSyncError(a)), [dispatchId, kind])
  const load = useCallback(async () => {
    const { data, error: e } = await createClient().rpc('dispatch_odometer_state', { p_dispatch: dispatchId })
    // Sin señal, la lectura en cola basta para seguir (el servidor la valida al sincronizar)
    if (e) { setError(e.message); onReady(!!queued()); return }
    const s = data as State
    setState(s)
    const done = !s.own_unit || (kind === 'SALIDA' ? s.start_odometer != null : s.end_odometer != null || s.start_odometer == null)
    onReady(done || !!queued())
  }, [dispatchId, kind, onReady, queued])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  const save = async () => {
    const km = Number(value.replace(',', '.'))
    if (!(km > 0)) { setError('Ingrese el odómetro que marca el tablero'); return }
    setBusy(true); setError('')
    try {
      const photo = file ? await asBase64(await compressPhoto(file)) : null  // la foto es opcional (cámara averiada)
      const id = crypto.randomUUID()
      saveOfflineAction('dispatch_odometer', { dispatch_id: dispatchId, user_id: userId, kind, value: km, photo_base64: photo, at: new Date().toISOString() }, id)
      if (navigator.onLine) await syncOfflineActions().catch(() => {})
      const failed = readActionQueue().find(a => a.id === id && a.status === 'error')
      if (failed && isPermanentSyncError(failed)) {
        // Rechazo del servidor (lectura incoherente): se corrige y se vuelve a enviar, no se deja en cola
        localStorage.setItem(actionQueueKey, JSON.stringify(readActionQueue().filter(a => a.id !== id)))
        setError(failed.last_error || 'No se pudo registrar el odómetro')
      } else { setValue(''); setFile(null) }  // enviada o en cola por un error de red: se reintenta sola
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo guardar la lectura') }
    finally { setBusy(false) }
  }

  const pending = queued()
  if (!state && pending) return <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-amber-800">Odómetro guardado en el teléfono; se enviará al haber señal.</p>
  if (!state || !state.own_unit) return null
  if (kind === 'LLEGADA' && state.start_odometer == null) return null
  const recorded = kind === 'SALIDA' ? state.start_odometer : state.end_odometer
  return <div className="rounded-xl border border-slate-200 bg-white p-4 text-left text-sm">
    <p className="flex items-center gap-2 font-semibold text-[#002855]"><Gauge className="h-4 w-4" aria-hidden />Odómetro de {kind === 'SALIDA' ? 'salida' : 'llegada a base'}</p>
    {recorded != null ? <><p className="mt-1 text-emerald-700">Registrado: {recorded.toLocaleString('es-PE')} km{kind === 'LLEGADA' && state.km != null ? ` · viaje ${state.km.toLocaleString('es-PE')} km` : ''}</p>
        {kind === 'LLEGADA' && <CloseDayHere odometer={recorded} />}</>
      : pending ? <p className="mt-1 text-amber-800">Lectura guardada en el teléfono; se enviará al haber señal.{pending.last_error ? ` Último intento: ${pending.last_error}` : ''}</p>
      : <div className="mt-2 space-y-2">
          <p className="text-xs text-slate-600">Obligatorio: el número que marca el tablero. La foto es opcional, pero ayuda si hay dudas.</p>
          <input inputMode="decimal" placeholder="Ej.: 125430" aria-label="Odómetro (km)" value={value} onChange={e => setValue(e.target.value.replace(/[^0-9.,]/g, ''))} className="min-h-11 w-full rounded-lg border border-slate-300 px-3" />
          <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-slate-300 px-3"><Camera className="h-4 w-4" aria-hidden />{file ? 'Foto lista · cambiar' : 'Foto del tablero (opcional)'}
            <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="sr-only" onChange={e => { setFile(e.target.files?.[0] || null); e.target.value = '' }} /></label>
          <button type="button" disabled={busy || !value} onClick={() => void save()} className="min-h-11 w-full rounded-lg bg-[#002855] px-3 font-semibold text-white disabled:opacity-50">{busy ? 'Guardando…' : 'Registrar odómetro'}</button>
        </div>}
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
  </div>
}
