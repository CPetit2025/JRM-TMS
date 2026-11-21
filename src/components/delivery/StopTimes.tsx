'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { readActionQueue, saveOfflineAction, syncOfflineActions } from '@/lib/route-point-sync'
import { WAIT_REASONS } from '@/lib/route-incidents'
import { deliveryTime } from '@/lib/delivery'

type Wait = { id: string; reason: string; note: string | null; started_at: string; ended_at: string | null }
type Times = { arrived_at: string | null; departed_at: string | null; waits: Wait[] }

/** Esperas y salida de la parada. Se guardan primero en el teléfono (hora del evento) y se envían al haber señal. */
export function StopTimes({ dispatchId, requestId }: { dispatchId: string; requestId: string }) {
  const [times, setTimes] = useState<Times | null>(null), [error, setError] = useState('')
  const [reason, setReason] = useState(''), [note, setNote] = useState(''), [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const { data, error: e } = await createClient().rpc('route_stop_times', { p_dispatch: dispatchId, p_request: requestId })
    const server: Times = e || !data ? { arrived_at: null, departed_at: null, waits: [] } : data as Times
    // Lo guardado sin conexión se muestra encima de lo confirmado por el servidor
    const waits = new Map(server.waits.map(w => [w.id, w]))
    let departed = server.departed_at
    for (const a of readActionQueue()) {
      const p = a.payload
      if (p.dispatch_id !== dispatchId || p.request_id !== requestId) continue
      if (a.type === 'route_stop_wait') {
        const id = String(p.wait_id), prev = waits.get(id)
        waits.set(id, { id, reason: String(prev?.reason || p.reason || 'OTRO'), note: prev?.note ?? (p.note as string | null) ?? null,
          started_at: prev?.started_at || String(p.started_at), ended_at: prev?.ended_at || (p.ended_at as string | null) || null })
      }
      if (a.type === 'delivery_depart' && !departed) departed = String(p.at)
    }
    setTimes({ ...server, departed_at: departed, waits: [...waits.values()].sort((a, b) => a.started_at.localeCompare(b.started_at)) })
    setError(e ? e.message : '')
  }, [dispatchId, requestId])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  const save = async (type: string, payload: Record<string, unknown>) => {
    setBusy(true); setError('')
    saveOfflineAction(type, { dispatch_id: dispatchId, request_id: requestId, ...payload })
    if (navigator.onLine) await syncOfflineActions().catch(() => {})
    const failed = readActionQueue().find(a => a.type === type && a.payload.dispatch_id === dispatchId && a.status === 'error')
    if (failed?.last_error) setError(failed.last_error)
    await load(); setBusy(false)
  }
  if (!times) return null
  const open = times.waits.find(w => !w.ended_at)
  const now = () => new Date().toISOString()
  return <div className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm">
    <p className="font-semibold text-[#002855]">Tiempos en la parada</p>
    {times.waits.length > 0 && <ul className="space-y-1 text-xs text-slate-700">{times.waits.map(w => <li key={w.id}>
      Espera · {WAIT_REASONS[w.reason] || w.reason}{w.note ? ` (${w.note})` : ''}: {deliveryTime(w.started_at)} → {w.ended_at ? deliveryTime(w.ended_at) : 'en curso'}</li>)}</ul>}
    {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    {times.departed_at ? <p className="text-xs text-emerald-700">Salida de la parada {deliveryTime(times.departed_at)}</p> : open
      ? <button type="button" disabled={busy} onClick={() => void save('route_stop_wait', { wait_id: open.id, started_at: open.started_at, ended_at: now() })}
          className="min-h-11 w-full rounded-lg bg-amber-600 px-3 font-semibold text-white disabled:opacity-50">Terminar espera</button>
      : <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <label className="sr-only" htmlFor={`wait-${requestId}`}>Motivo de la espera</label>
            <select id={`wait-${requestId}`} value={reason} onChange={e => setReason(e.target.value)} className="min-h-11 flex-1 rounded-lg border border-slate-300 px-2">
              <option value="">Motivo de la espera…</option>
              {Object.entries(WAIT_REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <button type="button" disabled={busy || !reason || (reason === 'OTRO' && note.trim().length < 5)}
              onClick={() => { void save('route_stop_wait', { wait_id: crypto.randomUUID(), reason, note: note.trim() || null, started_at: now() }); setReason(''); setNote('') }}
              className="min-h-11 rounded-lg border border-amber-300 px-3 font-semibold text-amber-900 disabled:opacity-50">Iniciar espera</button>
          </div>
          {reason === 'OTRO' && <input value={note} onChange={e => setNote(e.target.value)} maxLength={300} placeholder="Describa el motivo" aria-label="Describa el motivo" className="min-h-11 w-full rounded-lg border border-slate-300 px-3" />}
          <button type="button" disabled={busy} onClick={() => void save('delivery_depart', { at: now() })}
            className="min-h-11 w-full rounded-lg border border-slate-300 px-3 font-semibold text-[#002855] disabled:opacity-50">Registrar salida de la parada</button>
        </div>}
  </div>
}
