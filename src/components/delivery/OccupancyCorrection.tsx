'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

/** % de ocupación de la unidad en la parada (FR-DT.004): lo registra Despacho al programar y el conductor lo corrige al cargar. */
export function OccupancyCorrection({ dispatchId, requestId }: { dispatchId: string; requestId: string }) {
  const [pct, setPct] = useState<number | null>(null), [draft, setDraft] = useState(''), [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void createClient().rpc('dispatch_stop_occupancy', { p_dispatch: dispatchId, p_request: requestId }).then(({ data }) => { if (alive && data) setPct(data.pct ?? null) })
    return () => { alive = false }
  }, [dispatchId, requestId])
  const save = async () => {
    const v = Number(draft.replace(',', '.'))
    if (!(v > 0 && v <= 100)) { setError('Indique un valor de 1 a 100.'); return }
    setBusy(true); setError('')
    const { data, error: e } = await createClient().rpc('dispatch_stop_occupancy', { p_dispatch: dispatchId, p_request: requestId, p_pct: v })
    setBusy(false)
    if (e) { setError(navigator.onLine ? e.message : 'Sin conexión: corrija la ocupación cuando tenga señal.'); return }
    setPct(data?.pct ?? v); setEditing(false)
  }
  return <div className="rounded-lg bg-slate-50 p-2 text-xs text-slate-700">
    {editing ? <div className="flex flex-wrap items-center gap-2">
      <label className="font-semibold">Ocupación real de la unidad (%)<input type="number" min="1" max="100" inputMode="numeric" value={draft} onChange={e => setDraft(e.target.value)} className="ml-2 min-h-11 w-20 rounded-lg border bg-white px-2 text-right" /></label>
      <button type="button" disabled={busy} onClick={() => setEditing(false)} className="min-h-11 rounded-lg border bg-white px-3">Cancelar</button>
      <button type="button" disabled={busy} onClick={() => void save()} className="min-h-11 rounded-lg bg-[#002855] px-3 font-semibold text-white">{busy ? 'Guardando…' : 'Guardar'}</button>
    </div> : <p>Ocupación de la unidad en esta parada: <b>{pct == null ? 'sin registrar' : `${pct} %`}</b>
      <button type="button" onClick={() => { setDraft(pct == null ? '' : String(pct)); setEditing(true) }} className="ml-2 min-h-9 font-semibold text-blue-700 underline">Corregir</button></p>}
    {error && <p role="alert" className="mt-1 text-red-700">{error}</p>}
  </div>
}
