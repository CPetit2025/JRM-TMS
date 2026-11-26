'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { readActionQueue, saveOfflineAction } from '@/lib/route-point-sync'

/** Inicio de descarga (FR-DT.004): separa la espera de la descarga. Antes de enviar la guía es obligatorio responder. */
export function UnloadMark({ dispatchId, requestId, required, onDone }: { dispatchId: string; requestId: string; required: boolean; onDone: (done: boolean) => void }) {
  // Marca guardada sin señal: cuenta como respondida mientras no la haya rechazado el servidor
  const [queued] = useState(() => readActionQueue().find(a => a.type === 'delivery_mark_unload' && a.payload.dispatch_id === dispatchId && a.payload.request_id === requestId))
  const queuedAt = queued?.status === 'pending' ? queued.payload.at as string : undefined
  const [state, setState] = useState<'cargando' | 'pendiente' | 'listo'>(queuedAt ? 'listo' : 'cargando'), [at, setAt] = useState<string | null>(queuedAt ?? null)
  const [mins, setMins] = useState(''), [error, setError] = useState(queued?.status === 'error' ? `No se guardó la hora marcada: ${queued.last_error || 'rechazada'}. Vuelva a indicarla.` : ''), [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    if (queuedAt) { onDone(true); return }
    void createClient().rpc('delivery_unload_status', { p_dispatch: dispatchId, p_request: requestId }).then(({ data }) => {
      if (!alive) return
      const done = !!data?.unload_started_at
      setState(done ? 'listo' : 'pendiente'); setAt(data?.unload_started_at ?? null); onDone(done)
    }, () => { if (alive) { setState('pendiente'); onDone(false) } })
    return () => { alive = false }
  }, [dispatchId, requestId, onDone, queuedAt])
  const mark = async (when: Date, noWait = false) => {
    setBusy(true); setError('')
    try {
      // Sin señal queda en cola y cuenta como respondida; con señal se espera la respuesta del servidor
      if (!navigator.onLine) {
        saveOfflineAction('delivery_mark_unload', { dispatch_id: dispatchId, request_id: requestId, at: when.toISOString(), no_wait: noWait })
        setState('listo'); setAt(when.toISOString()); onDone(true); return
      }
      const { error: e } = await createClient().rpc('delivery_mark_unload', { p_dispatch: dispatchId, p_request: requestId, p_at: noWait ? null : when.toISOString(), p_no_wait: noWait })
      if (e) { setError(e.message); return }
      setState('listo'); setAt(when.toISOString()); onDone(true)
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo guardar la hora de descarga') } finally { setBusy(false) }
  }
  if (state === 'cargando') return null
  if (state === 'listo') return <p className="rounded-lg bg-emerald-50 p-2 text-xs text-emerald-900">Inicio de descarga registrado{at ? ` · ${new Date(at).toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit' })}` : ''}.</p>
  if (!required) return <button type="button" disabled={busy} onClick={() => void mark(new Date())} className="min-h-11 w-full rounded-lg border border-blue-300 bg-white px-3 text-sm font-semibold text-blue-900">Empecé a descargar</button>
  const m = Number(mins)
  return <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" role="group" aria-label="Inicio de descarga">
    <p className="font-semibold">¿A qué hora empezaste a descargar?</p>
    <p className="text-xs">Es obligatorio antes de enviar la guía: separa el tiempo de espera del tiempo de descarga.</p>
    <div className="grid gap-2">
      <button type="button" disabled={busy} onClick={() => void mark(new Date(), true)} className="min-h-11 rounded-lg border bg-white px-3 text-left font-semibold">Al llegar (no hubo espera)</button>
      <button type="button" disabled={busy} onClick={() => void mark(new Date())} className="min-h-11 rounded-lg border bg-white px-3 text-left font-semibold">Ahora mismo</button>
      <div className="flex items-center gap-2">
        <label className="flex flex-1 items-center gap-2">Hace<input type="number" min="1" max="600" inputMode="numeric" value={mins} onChange={e => setMins(e.target.value)} className="min-h-11 w-20 rounded-lg border bg-white px-2 text-right" aria-label="Minutos desde que empezó a descargar" />min</label>
        <button type="button" disabled={busy || !(m > 0 && m <= 600)} onClick={() => void mark(new Date(Date.now() - m * 60000))} className="min-h-11 rounded-lg bg-[#002855] px-3 font-semibold text-white disabled:opacity-50">Guardar</button>
      </div>
    </div>
    {error && <p role="alert" className="text-red-700">{error}</p>}
  </div>
}
